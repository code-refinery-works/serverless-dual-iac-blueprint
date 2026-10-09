#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { ServerlessApiStack } from "../lib/stack";

const app = new cdk.App();

const env = (app.node.tryGetContext("environment") as string) ?? "dev";

new ServerlessApiStack(app, `ServerlessApiStack-${env}`, {
  environment: env,
  env: { region: "ap-northeast-1" },
  description: `Serverless API stack (${env}) - API Gateway + Lambda + DynamoDB`,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }));