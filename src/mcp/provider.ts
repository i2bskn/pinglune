import { GrantType, OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import app from "../app";
import type { Bindings } from "../env";
import { MCP_SCOPE, isMcpProps, mcpHandler } from "./handler";

const ACCESS_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
// The same lifetime as a web session in oidc mode.
const OIDC_REFRESH_TOKEN_TTL_SECONDS = 24 * 60 * 60;

// Exported so that tests can read grants with getOAuthApi(options, env).
export function buildOAuthProviderOptions(origin: string): OAuthProviderOptions<Bindings> {
  return {
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [MCP_SCOPE],
    requiredScopes: [MCP_SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: true,
    // Longer than the 1 hour default to keep KV writes for refreshes low (the free plan allows
    // 1,000 writes a day). Users are read from the DB on every MCP request, so role changes and
    // deletions take effect immediately. On refresh, the library caps it at the grant's remaining lifetime.
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    tokenExchangeCallback: ({ grantType, props }) => {
      if (grantType === GrantType.AUTHORIZATION_CODE && isMcpProps(props) && props.authMode === "oidc") {
        return { refreshTokenTTL: OIDC_REFRESH_TOKEN_TTL_SECONDS };
      }
      return undefined;
    },
  };
}

// resourceMetadata.resource must be a fixed absolute URL, so there is one provider per origin.
const providers = new Map<string, OAuthProvider<Bindings>>();

export function getOAuthProvider(origin: string): OAuthProvider<Bindings> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider(buildOAuthProviderOptions(origin));
    providers.set(origin, provider);
  }
  return provider;
}
