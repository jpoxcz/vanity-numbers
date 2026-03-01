import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { handler } from "../src/index";

const ddbMock = mockClient(DynamoDBClient);

describe("vanity handler", () => {
  beforeEach(() => {
    process.env.VANITY_TABLE_NAME = "TestTable";
    ddbMock.reset();
  });

  it("generates vanity options and writes to DynamoDB", async () => {
    ddbMock.on(PutItemCommand).resolves({});

    const res = await handler({
      Details: {
        ContactData: {
          CustomerEndpoint: { Address: "+1-800-356-9377" },
        },
      },
    });

    console.log("res", JSON.stringify(res, null, 2));

    expect(res).toEqual(
      expect.objectContaining({
        vanity1: expect.any(String),
        vanity2: expect.any(String),
        vanity3: expect.any(String),
      }),
    );

    // vanity is either pure digits or "<digits>-<WORD>"
    expect(res.vanity1).toMatch(/^(?:\d+|\d+(?:-\d+)*-[A-Z]+)$/);

    const calls = ddbMock.commandCalls(PutItemCommand);
    expect(calls.length).toBe(1);
    expect(calls[0].args[0].input.TableName).toBe("TestTable");
  });

  it("falls back to a test number when caller missing", async () => {
    ddbMock.on(PutItemCommand).resolves({});

    const res = await handler({});
    expect(res.vanity1).toBe("");

    const calls = ddbMock.commandCalls(PutItemCommand);
    expect(calls.length).toBe(1);
  });
});
