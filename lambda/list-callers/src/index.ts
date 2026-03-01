import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({});

export async function handler(): Promise<APIGatewayProxyStructuredResultV2> {
  const tableName = process.env.VANITY_TABLE_NAME;

  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "GlobalVanityByCreatedAtIndex",
      KeyConditionExpression: "entityType = :type",
      ExpressionAttributeValues: {
        ":type": { S: "VANITY" },
      },
      ScanIndexForward: false,
      Limit: 5,
    }),
  );

  const items = (result.Items || []).map((i) => unmarshall(i));
  const body = JSON.stringify({ callers: items });

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body,
  };
}

