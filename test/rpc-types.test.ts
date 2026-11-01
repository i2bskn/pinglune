import { hc, type InferRequestType, type InferResponseType } from "hono/client";
import { describe, expectTypeOf, it } from "vitest";
import type {
  ApiKey,
  ApiKeyList,
  CreateSourceRequest,
  CreateUserRequest,
  CreatedApiKey,
  EventDetail,
  EventList,
  Source,
  SourceList,
  User,
  UserList,
} from "../src/api/types";
import type { AppType } from "../src/index";
import { ORIGIN } from "./helpers";

// These assertions are checked by `pnpm typecheck`, not at runtime.
const client = hc<AppType>(ORIGIN);

type CreateUserJson = InferRequestType<typeof client.api.v1.users.$post>["json"];

describe("AppType", () => {
  it("types the request body of POST /api/v1/users", () => {
    expectTypeOf<CreateUserJson>().toEqualTypeOf<CreateUserRequest>();
    const withoutName: CreateUserJson = { email: "a@example.com", password: "correct horse battery", role: "member" };
    // @ts-expect-error role must be admin or member
    const owner: CreateUserJson = { email: "a@example.com", password: "correct horse battery", role: "owner" };
    void withoutName;
    void owner;
  });

  it("types successful response bodies", () => {
    expectTypeOf<InferResponseType<typeof client.api.v1.me.$get, 200>>().toEqualTypeOf<User>();
    expectTypeOf<InferResponseType<typeof client.api.v1.users.$get, 200>>().toEqualTypeOf<UserList>();
    expectTypeOf<InferResponseType<typeof client.api.v1.users.$post, 201>>().toEqualTypeOf<User>();
  });

  it("types the deletion of a user", () => {
    expectTypeOf<UserList["auth_mode"]>().toEqualTypeOf<"oidc" | "password">();
    const param: InferRequestType<(typeof client.api.v1.users)[":id"]["$delete"]>["param"] = { id: "u1" };
    // @ts-expect-error id is required
    const withoutId: InferRequestType<(typeof client.api.v1.users)[":id"]["$delete"]>["param"] = {};
    void param;
    void withoutId;
  });

  it("types the sources, API keys and events", () => {
    expectTypeOf<InferRequestType<typeof client.api.v1.sources.$post>["json"]>().toEqualTypeOf<CreateSourceRequest>();
    expectTypeOf<InferResponseType<typeof client.api.v1.sources.$get, 200>>().toEqualTypeOf<SourceList>();
    expectTypeOf<InferResponseType<typeof client.api.v1.sources.$post, 201>>().toEqualTypeOf<Source>();
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.sources)[":id"]["api-keys"]["$get"], 200>
    >().toEqualTypeOf<ApiKeyList>();
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.sources)[":id"]["api-keys"]["$post"], 201>
    >().toEqualTypeOf<CreatedApiKey>();
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.sources)[":id"]["api-keys"][":keyId"]["revoke"]["$post"], 200>
    >().toEqualTypeOf<ApiKey>();
    expectTypeOf<InferResponseType<typeof client.api.v1.events.$get, 200>>().toEqualTypeOf<EventList>();
    // labels (a Record) comes out of hono's JSON typing with optional values, so only data is compared exactly.
    expectTypeOf<InferResponseType<(typeof client.api.v1.events)[":id"]["$get"], 200>>()
      .toHaveProperty("data")
      .toEqualTypeOf<EventDetail["data"]>();
    const query: InferRequestType<typeof client.api.v1.events.$get>["query"] = {};
    void query;
  });
});
