# CDK (LocalStack-friendly)

This CDK app supports skipping Amazon Connect resources (since Connect isn’t supported by LocalStack).

## `.env` (ENABLE_CONNECT)

Create a file at `cdk/.env`:

```bash
ENABLE_CONNECT=false
```

- **`ENABLE_CONNECT=false`**: deploys DynamoDB/Lambdas/API/S3 only (no Connect resources)
- **`ENABLE_CONNECT=true`** (or missing): deploys everything including Connect (for real AWS)

The CDK entrypoint (`cdk/bin/app.ts`) loads `cdk/.env` automatically using `dotenv`.

## Alternative: CDK context flag

You can also disable Connect using CDK context:

```bash
npx cdk deploy -c enableConnect=false
```

