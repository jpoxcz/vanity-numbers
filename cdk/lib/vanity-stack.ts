import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as connect from "aws-cdk-lib/aws-connect";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";
import * as fs from "fs";

export class VanityStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Resolve repo root (cdk/dist/lib -> repo)
    const repoRoot = path.join(__dirname, "..", "..", "..");

    const enableConnect = (() => {
      const raw =
        this.node.tryGetContext("enableConnect") ?? process.env.ENABLE_CONNECT;
      if (raw === undefined) return true;
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      return !["false", "0", "no", "off"].includes(s);
    })();

    // DynamoDB: pk = CALLER, sk = ISO timestamp (for "last 5 callers" query)
    const table = new dynamodb.Table(this, "VanityTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Secondary Index
    table.addGlobalSecondaryIndex({
      indexName: "GlobalVanityByCreatedAtIndex",
      partitionKey: {
        name: "entityType",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "createdAt",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Vanity Lambda (called by Connect) - bundled from TypeScript
    const vanityLambda = new nodejs.NodejsFunction(this, "VanityLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(repoRoot, "lambda", "vanity", "src", "index.ts"),
      handler: "handler",
      environment: { VANITY_TABLE_NAME: table.tableName },
      timeout: cdk.Duration.seconds(8),
      bundling: {
        target: "node20",
        format: nodejs.OutputFormat.CJS,
        minify: true,
        sourceMap: true,
      },
      // Avoid "multiple lock files found" errors (cdklocal, monorepo)
      depsLockFilePath: path.join(repoRoot, "package-lock.json"),
      projectRoot: repoRoot,
    });
    table.grantWriteData(vanityLambda);

    if (enableConnect) {
      // Allow Amazon Connect to invoke the Lambda (account/region/instance agnostic pattern)
      vanityLambda.addPermission("AllowConnectInvoke", {
        principal: new iam.ServicePrincipal("connect.amazonaws.com"),
        action: "lambda:InvokeFunction",
        sourceAccount: this.account,
      });
    }

    // List-callers Lambda (for web app API) - bundled from TypeScript
    const listCallersLambda = new nodejs.NodejsFunction(
      this,
      "ListCallersLambda",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(repoRoot, "lambda", "list-callers", "src", "index.ts"),
        handler: "handler",
        environment: { VANITY_TABLE_NAME: table.tableName },
        bundling: {
          target: "node20",
          format: nodejs.OutputFormat.CJS,
          minify: true,
          sourceMap: true,
        },
        depsLockFilePath: path.join(repoRoot, "package-lock.json"),
        projectRoot: repoRoot,
      },
    );
    table.grantReadData(listCallersLambda);

    // API Gateway: GET /last5 -> ListCallersLambda
    const api = new apigateway.RestApi(this, "VanityApi", {
      restApiName: "Vanity Numbers API",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });
    const last5 = api.root.addResource("last5");
    last5.addMethod("GET", new apigateway.LambdaIntegration(listCallersLambda));

    // Web app: static site in S3 (HTML/JS that calls API)
    const webBucket = new s3.Bucket(this, "WebBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        restrictPublicBuckets: false,
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
      }),
      websiteIndexDocument: "index.html",
      publicReadAccess: true,
    });

    const webDir = path.join(repoRoot, "web-app");

    if (!fs.existsSync(webDir)) {
      throw new Error(
        `[DeployWeb] webDir not found: "${webDir}". ` +
          `Check the folder name and that repoRoot is correct: "${repoRoot}"`,
      );
    }

    new s3deploy.BucketDeployment(this, "DeployWeb", {
      sources: [s3deploy.Source.asset(webDir)],
      destinationBucket: webBucket,
      prune: true,
      memoryLimit: 512, // ← default 128MB can silently fail on larger assets
      contentType: "text/html",
    });

    if (enableConnect) {
      // Amazon Connect instance (optional: creates instance; claim number in console)
      const instanceAlias =
        `vanity-${this.account}-${Date.now().toString(36)}`.slice(0, 32);
      const connectInstance = new connect.CfnInstance(this, "ConnectInstance", {
        identityManagementType: "CONNECT_MANAGED",
        instanceAlias,
        attributes: {
          inboundCalls: true,
          outboundCalls: false,
          contactflowLogs: true,
          contactLens: false,
          autoResolveBestVoices: true,
          useCustomTtsVoices: false,
        },
      });

      const integration = new connect.CfnIntegrationAssociation(
        this,
        "LambdaIntegration",
        {
          instanceId: connectInstance.attrId,
          integrationType: "LAMBDA_FUNCTION",
          integrationArn: vanityLambda.functionArn,
        },
      );
      integration.addDependency(connectInstance);

      // Contact flow content: inject Lambda ARN
      const flowTemplatePath = path.join(
        __dirname,
        "../../connect-flows/vanity-inbound.json",
      );
      let flowContent = fs.readFileSync(flowTemplatePath, "utf8");
      flowContent = flowContent.replace(
        "LAMBDA_ARN_PLACEHOLDER",
        vanityLambda.functionArn,
      );

      const contactFlow = new connect.CfnContactFlow(
        this,
        "VanityInboundFlow",
        {
          instanceArn: connectInstance.attrArn,
          name: "Vanity Inbound Flow",
          type: "CONTACT_FLOW",
          state: "ACTIVE",
          content: flowContent,
        },
      );
      contactFlow.addDependency(integration);

      new cdk.CfnOutput(this, "ConnectInstanceId", {
        value: connectInstance.attrId,
        description: "Amazon Connect instance ID",
      });
      new cdk.CfnOutput(this, "ConnectInstanceAlias", {
        value: instanceAlias,
        description: "Connect instance alias (login URL)",
      });
      new cdk.CfnOutput(this, "ContactFlowId", {
        value: contactFlow.ref,
        description: "Inbound contact flow ID",
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "VanityTableName", {
      value: table.tableName,
      description: "DynamoDB Vanity table",
    });
    new cdk.CfnOutput(this, "VanityLambdaArn", {
      value: vanityLambda.functionArn,
      description: "Vanity Lambda ARN (for Connect)",
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: `${api.url}last5`,
      description: "API URL for last 5 callers",
    });
    new cdk.CfnOutput(this, "WebBucketName", {
      value: webBucket.bucketName,
      description: "Web app S3 bucket name",
    });
    new cdk.CfnOutput(this, "WebAppUrl", {
      value: webBucket.bucketWebsiteUrl,
      description:
        "Web app URL (paste ApiUrl into the page to load last 5 callers)",
    });
  }
}
