/**
 * Returns last 5 callers and their vanity numbers from DynamoDB.
 * Used by the web app via API Gateway.
 */
const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const TABLE_NAME = process.env.VANITY_TABLE_NAME;
const dynamo = new DynamoDBClient({});

exports.handler = async (event) => {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GlobalVanityByCreatedAtIndex",
      KeyConditionExpression: "entityType = :type",
      ExpressionAttributeValues: {
        ":type": "VANITY",
      },
      ScanIndexForward: false, // DESC order
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
};
