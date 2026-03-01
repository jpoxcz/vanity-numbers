import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { marshall } from "@aws-sdk/util-dynamodb";
import { handler } from "../src/index";

const ddbMock = mockClient(DynamoDBClient);

describe("list-callers handler", () => {
  beforeEach(() => {
    process.env.VANITY_TABLE_NAME = "TestTable";
    ddbMock.reset();
  });

  it("queries the last 5 items and returns JSON", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        marshall({
          callerNumber: "14155551234",
          vanity1: "ABC-DEFG",
          entityType: "VANITY",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });

    const res = await handler();

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }),
    );

    const body = JSON.parse(res.body || "{}");
    expect(body.callers).toHaveLength(1);
    expect(body.callers[0]).toEqual(
      expect.objectContaining({
        callerNumber: "14155551234",
        vanity1: "ABC-DEFG",
      }),
    );

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls.length).toBe(1);
    expect(calls[0].args[0].input).toEqual(
      expect.objectContaining({
        TableName: "TestTable",
        IndexName: "GlobalVanityByCreatedAtIndex",
        Limit: 5,
        ScanIndexForward: false,
      }),
    );
  });
});

