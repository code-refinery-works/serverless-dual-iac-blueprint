terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket         = "your-tfstate-bucket"
    key            = "serverless-api/terraform.tfstate"
    region         = "ap-northeast-1"
    dynamodb_table = "terraform-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = "ap-northeast-1"
  default_tags { tags = local.common_tags }
}

locals {
  name        = "serverless-api-${var.environment}"
  common_tags = { Environment = var.environment, ManagedBy = "Terraform", Project = "serverless-api" }
  is_prod     = var.environment == "prod"
}

# ── DynamoDB ──────────────────────────────────────────────
resource "aws_dynamodb_table" "items" {
  name         = "${local.name}-items"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute { name = "id", type = "S" }

  point_in_time_recovery { enabled = local.is_prod }
  deletion_protection_enabled = local.is_prod

  server_side_encryption { enabled = true }
}

# ── IAM ───────────────────────────────────────────────────
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals { type = "Service", identifiers = ["lambda.amazonaws.com"] }
  }
}

data "aws_iam_policy_document" "lambda_policy" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.items.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name}-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

# ── CloudWatch Logs ───────────────────────────────────────
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = local.is_prod ? 30 : 7
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigateway/${local.name}"
  retention_in_days = local.is_prod ? 30 : 7
}

# ── Lambda ────────────────────────────────────────────────
data "archive_file" "lambda" {
  type        = "zip"
  output_path = "${path.module}/lambda.zip"
  source {
    content  = <<-PY
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
    PY
    filename = "index.py"
  }
}

resource "aws_lambda_function" "api" {
  function_name    = local.name
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  role             = aws_iam_role.lambda.arn
  handler          = "index.handler"
  runtime          = "python3.12"
  architectures    = ["arm64"]
  memory_size      = local.is_prod ? 512 : 256
  timeout          = 29
  environment { variables = { TABLE_NAME = aws_dynamodb_table.items.name } }
  depends_on       = [aws_cloudwatch_log_group.lambda]
}

# ── API Gateway (HTTP API) ────────────────────────────────
resource "aws_apigatewayv2_api" "api" {
  name          = local.name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# ── CloudWatch Alarms ─────────────────────────────────────
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.name}-lambda-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_description   = "Lambda error detected"
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${local.name}-lambda-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_description   = "Lambda throttle detected"
}

resource "aws_cloudwatch_metric_alarm" "dynamodb_errors" {
  alarm_name          = "${local.name}-dynamodb-system-errors"
  namespace           = "AWS/DynamoDB"
  metric_name         = "SystemErrors"
  dimensions          = { TableName = aws_dynamodb_table.items.name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_description   = "DynamoDB system error detected"
}