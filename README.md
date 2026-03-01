# Amazon Connect Vanity Numbers

A working Amazon Connect setup that converts caller phone numbers to vanity number suggestions, stores the best five in DynamoDB, speaks three options in-call, and exposes a web app showing the last five callers.

## Deliverables

1. **Working Amazon Connect phone number** – After deploy, claim a number in the Connect console and set the “Vanity Inbound Flow” as the inbound flow for that number.
2. **Web app** – Displays vanity numbers from the last 5 callers (paste the **ApiUrl** from CDK outputs into the page).

## What’s in this repo

1. **Lambda: vanity conversion** – Converts the caller’s number to vanity combinations (keypad 2=ABC, 3=DEF, …), scores them, saves the best 5 plus caller to DynamoDB, and returns 3 options for Connect to speak. “Best” = most letters (prefer more letter substitutions), then stable order; no external word list.
2. **Amazon Connect contact flow** – Invokes the Lambda (synchronous), then plays a prompt saying the three vanity options from `$.External.vanity1`, `$.External.vanity2`, `$.External.vanity3`.
3. **IaC** – AWS CDK (TypeScript): DynamoDB table, both Lambdas, API Gateway, S3 web app, Connect instance, Lambda integration, and the contact flow.
4. **Web app** – Static HTML/JS in S3; user enters the API URL (from CDK output) and clicks Load to show last 5 callers and their vanity numbers.

## Architecture diagram

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                     Amazon Connect                           │
                    │  ┌──────────────┐    ┌─────────────────┐    ┌────────────┐  │
  Caller ──────────►│  │ Inbound      │───►│ Invoke Lambda   │───►│ Play       │  │
  (phone)            │  │ (this flow)  │    │ (VanityLambda)  │    │ 3 options  │  │
                     │  └──────────────┘    └────────┬────────┘    └─────┬──────┘  │
                     │                               │                   │         │
                     └───────────────────────────────┼───────────────────┼─────────┘
                                                     │                   ▼
                                                     │              Disconnect
                                                     ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │  Lambda (Vanity)                                             │
                    │  • Digits → letter combos (keypad)                             │
                    │  • Score → best 5, return 3 for Connect                       │
                    │  • PutItem: pk=CALLER, sk=timestamp, callerNumber, vanity1-5  │
                    └───────────────────────────────┬───────────────────────────────┘
                                                    │
                                                    ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │  DynamoDB (VanityTable)                                       │
                    │  pk (CALLER) | sk (ISO time) | callerNumber | vanity1..5       │
                    └───────────────────────────────┬───────────────────────────────┘
                                                    │
                                                    │  Query pk=CALLER, sk DESC, Limit 5
                                                    ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │  Lambda (ListCallers)  ◄──── GET /last5 (API Gateway)         │
                    └───────────────────────────────┬───────────────────────────────┘
                                                     │
                                                     ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │  Web app (S3 static site)                                    │
                    │  User pastes ApiUrl, clicks Load → shows last 5 callers       │
                    └─────────────────────────────────────────────────────────────┘
```

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

- **“Best” vanity** – We score by number of letter characters (more letters = better), then take up to 5 unique. No word-list or profanity filter; easy to add later.
- **Connect event** – Caller number comes from `Details.ContactData.CustomerEndpoint.Address`; we normalize to digits and use the last 7 for vanity (US-style).
- **Flow** – Single inbound flow: Invoke Lambda (sync, 8s) → Play prompt with `$.External.vanity1/2/3` → Disconnect; error branch plays a sorry message and disconnects.
- **Last 5** – Single partition `pk = 'CALLER'`, sort key `sk = ISO timestamp`; query by pk, descending sk, limit 5.

## Shortcuts / not production-ready

- **Security** – API Gateway has no auth (open GET). Web app has no auth. S3 bucket is public read for the demo.
- **Connect** – Lambda permission allows any Connect in the same account to invoke; production would scope to the instance ARN.
- **Rate/cost** – No throttling, no caching, no WAF.
- **Web app** – API URL is manual; no CloudFront, no HTTPS for S3 (using S3 website endpoint).
- **Vanity** – No word list, no profanity filter, fixed 7-digit slice; non-US numbers not optimized.

## With more time

- Add a small word list and score by “forms a word” or “word-like”.
- Add profanity filter and blocklist.
- Auth for API (e.g. API key or Cognito) and optionally for the web app.
- CloudFront in front of S3 and API; HTTPS only; WAF.
- Inject ApiUrl into the web app at deploy (e.g. env in build or a small config endpoint).
- Connect: restrict Lambda permission to the specific instance ARN.
- Structured logging, metrics, and alarms (e.g. Lambda errors, Connect failures).

## Production / high-volume and security

- **Auth** – Protect `/last5` (API key, IAM, or Cognito) and consider auth for the dashboard.
- **WAF** – Rate limiting and basic rules on API Gateway (and CloudFront if added).
- **Connect** – Scope Lambda to instance ARN; use private Connect if in VPC.
- **DynamoDB** – Keep on-demand or set capacity with alarms; consider TTL for old records.
- **Secrets** – No secrets in code; use Parameter Store or Secrets Manager if needed.
- **Logging** – Centralized logs (e.g. CloudWatch Logs Insights), no PII in logs; consider encryption.
- **High volume** – Lambda and DynamoDB scale; add caching (e.g. API cache or ElastiCache) for last-5 if needed; consider Connect instance sizing and service quotas.

## Writing and documentation

- **Reasons** – Lambda for vanity keeps Connect flow simple and reuses the same logic for storage and voice. Single DynamoDB partition for “last 5” keeps queries simple and cost low. Flow speaks only 3 options to keep the call short.
- **Struggles** – Connect flow JSON (InvokeLambdaFunction + MessageParticipant with `$.External.*`) and ensuring STRING_MAP response; aligning CDK Connect resources (instance → integration → flow) and claiming a number in the console.
- **Shortcuts** – Listed above (open API, public S3, no auth, no word list).
- **More time** – Listed above (word list, auth, CloudFront, WAF, scoped Connect permissions).
- **High volume / attacks** – Listed in “Production / high-volume and security” above.

## License

MIT (or as required by your organization).
