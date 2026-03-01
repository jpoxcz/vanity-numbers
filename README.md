# Amazon Connect Vanity Numbers

A working Amazon Connect setup that converts caller phone numbers to vanity number suggestions, stores the best five in DynamoDB, speaks three options in-call or nothing, and exposes a web app showing the last five callers.

## Deliverables

1. **Working Amazon Connect phone number** – After deploy, claim a number in the Connect console and set the “Vanity Inbound Flow” as the inbound flow for that number.
2. **Web app** – Displays vanity numbers from the last 5 callers (paste the **ApiUrl** from CDK outputs into the page).

## What’s in this repo

1. **Lambda: vanity conversion** – Converts the caller’s number to vanity combinations (keypad 2=ABC, 3=DEF, …), scores them, saves the best 5 plus caller to DynamoDB, and returns 3 options for Connect to speak. “Best” = most letters (prefer more letter substitutions).
2. **Amazon Connect contact flow** – Invokes the Lambda (synchronous), then plays a prompt saying the three vanity options from `$.External.vanity1`, `$.External.vanity2`, `$.External.vanity3`.
3. **IaC** – AWS CDK (TypeScript): DynamoDB table, both Lambdas, API Gateway, S3 web app, Connect instance, Lambda integration, and the contact flow.
4. **Web app** – Static HTML/JS in S3; user enters the API URL (from CDK output) and clicks Load to show last 5 callers and their vanity numbers.

## How to run

### Prerequisites

- Node 18+, AWS CLI configured, bootstrap CDK in the account/region:  
  `npx cdk bootstrap`

### Deploy

```bash
cd amazon-connect-vanity
npm install
cd lambda/vanity && npm install && cd ../list-callers && npm install && cd ../..
cd cdk && npm install && npm run build && cd ..
npx cdk deploy --all --require-approval never
```

### Get a phone number and test

1. In **Amazon Connect console** → your instance (use **ConnectInstanceId** from outputs).
2. **Claim a number**: Channels → Phone numbers → Claim number. Choose a number and assign the **“Vanity Inbound Flow”** as the inbound contact flow for that number.
3. Call that number; you should hear the three vanity options.
4. **Web app**: Open **WebAppUrl** from outputs, paste **ApiUrl** into the box, click Load to see the last 5 callers and their vanity numbers.

## Implementation notes

- **“Best” vanity** – We score by number of letter characters (more letters = better), then take up to 5 unique.
- **Connect event** – Caller number comes from `Details.ContactData.CustomerEndpoint.Address`; we normalize to digits and use the last 7 for vanity (US-style).
- **Flow** – Single inbound flow: Invoke Lambda (sync, 8s) → Play prompt with `$.External.vanity1/2/3` → Disconnect; error branch plays a sorry message and disconnects.
- **Last 5** – Single partition `pk = 'entityType'`, sort key `sk = ISO timestamp`; query by GSI, entityType pk, descending sk, limit 5.

## License

MIT (or as required by your organization).
