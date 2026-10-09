import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";

interface Props extends cdk.StackProps { environment: string; }

export class ServerlessApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const isProd = props.environment === "prod";
    const tags   = { Environment: props.environment, ManagedBy: "CDK", Project: "serverless-api" };
    Object.entries(tags).forEach(([k, v]) => cdk.Tags.of(this).add(k, v));

    // ── DynamoDB ──────────────────────────────────────────
    const table = new dynamodb.Table(this, "ItemsTable", {
      tableName:           `serverless-api-${props.environment}-items`,
      partitionKey:        { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode:         dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption:          dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: isProd,
      deletionProtection:  isProd,
      removalPolicy:       isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ── CloudWatch Log Groups ─────────────────────────────
    const lambdaLogGroup = new logs.LogGroup(this, "LambdaLogGroup", {
      logGroupName:  `/aws/lambda/serverless-api-${props.environment}`,
      retention:     isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apigwLogGroup = new logs.LogGroup(this, "ApigwLogGroup", {
      logGroupName:  `/aws/apigateway/serverless-api-${props.environment}`,
      retention:     isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda ────────────────────────────────────────────
    const fn = new lambda.Function(this, "ApiFunction", {
      functionName:  `serverless-api-${props.environment}`,
      runtime:       lambda.Runtime.PYTHON_3_12,
      architecture:  lambda.Architecture.ARM_64,
      handler:       "index.handler",
      memorySize:    isProd ? 512 : 256,
      timeout:       cdk.Duration.seconds(29),
      logGroup:      lambdaLogGroup,
      environment:   { TABLE_NAME: table.tableName },
      code: lambda.Code.fromInline(`
import json, boto3, os, uuid
table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    if method == "GET":
        res = table.scan(); return {"statusCode": 200, "body": json.dumps(res["Items"])}
    if method == "POST":
        body = json.loads(event.get("body") or "{}"); body["id"] = body.get("id", str(uuid.uuid4()))
        table.put_item(Item=body); return {"statusCode": 201, "body": json.dumps(body)}
    return {"statusCode": 405, "body": "Method Not Allowed"}
`),
    });

    // 最小権限IAMポリシー（L2 grantメソッドを使用）
    table.grant(fn, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan");
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [`${lambdaLogGroup.logGroupArn}:*`],
    }));

    // ── API Gateway (HTTP API) ────────────────────────────
    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName:            `serverless-api-${props.environment}`,
      defaultIntegration: new integrations.HttpLambdaIntegration("LambdaIntegration", fn),
      defaultAuthorizer:  undefined,
    });

    // アクセスログ設定をCfnで付与（L2未サポート部分）
    const cfnStage = api.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = { destinationArn: apigwLogGroup.logGroupArn };

    // ── CloudWatch Alarms ─────────────────────────────────
    const alarmDefaults = { evaluationPeriods: 1, threshold: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD };

    new cloudwatch.Alarm(this, "LambdaErrorAlarm", {
      ...alarmDefaults,
      alarmName:   `serverless-api-${props.environment}-lambda-errors`,
      metric:      fn.metricErrors({ period: cdk.Duration.minutes(1) }),
      alarmDescription: "Lambda error detected",
    });
    new cloudwatch.Alarm(this, "LambdaThrottleAlarm", {
      ...alarmDefaults,
      alarmName:   `serverless-api-${props.environment}-lambda-throttles`,
      metric:      fn.metricThrottles({ period: cdk.Duration.minutes(1) }),
      alarmDescription: "Lambda throttle detected",
    });
    new cloudwatch.Alarm(this, "DynamoDbErrorAlarm", {
      ...alarmDefaults,
      alarmName:   `serverless-api-${props.environment}-dynamodb-system-errors`,
      metric:      table.metricSystemErrorsForOperations({ period: cdk.Duration.minutes(1) }),
      alarmDescription: "DynamoDB system error detected",
    });

    // ── Outputs ───────────────────────────────────────────
    new cdk.CfnOutput(this, "ApiEndpoint",       { value: api.apiEndpoint,       description: "HTTP API endpoint URL" });
    new cdk.CfnOutput(this, "DynamoDbTableName", { value: table.tableName,       description: "DynamoDB table name" });
    new cdk.CfnOutput(this, "LambdaFunctionName",{ value: fn.functionName,       description: "Lambda function name" });
  }
}