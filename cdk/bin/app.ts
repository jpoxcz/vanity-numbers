#!/usr/bin/env node
import 'source-map-support/register';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as cdk from 'aws-cdk-lib';
import { VanityStack } from '../lib/vanity-stack';

// Load cdk/.env when present (useful for localstack + ENABLE_CONNECT)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const app = new cdk.App();
new VanityStack(app, 'VanityStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'us-east-1' },
});
app.synth();
