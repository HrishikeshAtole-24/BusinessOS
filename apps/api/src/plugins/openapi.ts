import type { SwaggerOptions } from '@fastify/swagger';
import type { FastifySwaggerUiOptions } from '@fastify/swagger-ui';
import type { FastifySchema } from 'fastify';
import type { OpenAPIV3_1 } from 'openapi-types';
import { ERROR_CODES } from '@businessos/contracts';
import { env } from '../config/env.js';

/**
 * OpenAPI contract — report Sections 12.1 and 21.2.
 *
 *   "Use REST for the main application API with OpenAPI documentation."
 *   "Generate OpenAPI artifacts and validate compatibility."
 *
 * The spec is generated from the running route table rather than hand-written,
 * which is the only version that stays true. A hand-maintained document
 * describes what someone believed the API did when they last edited it.
 *
 * This module exports OPTIONS rather than registering anything. `app.ts` does
 * the registration, because this app passes a custom `loggerInstance` which
 * specialises Fastify's logger generic — a plugin wrapper here would be typed
 * against the default instance and the two would not match. Options are plain
 * data, so there is nothing to disagree about.
 */

/**
 * The shared error envelope, referenced by every failure response.
 *
 * Typed as an OpenAPI 3.1 SchemaObject so `type: 'object'` is checked against
 * the allowed set rather than widened to `string`.
 */
const errorSchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: {
          type: 'string',
          enum: Object.values(ERROR_CODES),
          description: 'Stable machine-readable code. Clients branch on this, never on `message`.',
        },
        message: {
          type: 'string',
          description: 'Human-readable. May be reworded without a breaking change.',
        },
        requestId: {
          type: 'string',
          description: 'Correlates with the x-request-id header and the server logs.',
        },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

/** Endpoints reachable without a session. */
const PUBLIC_ROUTES = [
  '/health',
  '/openapi.json',
  '/docs',
  '/v1/auth/login',
  '/v1/auth/signup',
  '/v1/invitations/preview',
  '/v1/invitations/accept',
];

/**
 * Derive a tag from the URL.
 *
 * Tagging each route by hand is metadata that rots: an endpoint gets added, the
 * tag is forgotten, and the document quietly misrepresents the API. Deriving it
 * from the path cannot drift.
 */
function tagFor(url: string): string | null {
  if (url.startsWith('/v1/auth')) return 'auth';
  if (url.startsWith('/v1/organizations')) return 'organizations';
  if (url.startsWith('/v1/invitations')) return 'invitations';
  if (
    url.startsWith('/v1/employees') ||
    url.startsWith('/v1/departments') ||
    url.startsWith('/v1/attendance') ||
    url.startsWith('/v1/leave')
  ) {
    return 'people';
  }
  if (url.startsWith('/v1/projects') || url.startsWith('/v1/tasks')) return 'work';
  if (url.startsWith('/v1/expense')) return 'finance';
  if (url.startsWith('/v1/approval')) return 'approvals';
  if (
    url.startsWith('/v1/notifications') ||
    url.startsWith('/v1/analytics') ||
    url.startsWith('/health')
  ) {
    return 'platform';
  }
  return null;
}

export const swaggerOptions: SwaggerOptions = {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'BusinessOS API',
      version: '0.1.0',
      description: [
        'Multi-tenant company operations platform.',
        '',
        '**Tenancy.** Every tenant-scoped endpoint derives its organization from the',
        'session, never from a request parameter. There is deliberately no',
        '`organizationId` input anywhere below: accepting one would let a client',
        'choose its own blast radius.',
        '',
        '**Authorization.** Endpoints are guarded by permission keys such as',
        '`expense.approve`, not by role names.',
        '',
        '**Errors.** Every failure uses one envelope with a stable `code`.',
        'A 404 may mean "not found" or "not yours" — the two are deliberately not',
        'distinguished, because confirming existence is itself a disclosure.',
      ].join('\n'),
    },
    servers: [
      { url: `http://localhost:${String(env.API_PORT)}`, description: 'Local development' },
    ],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: env.SESSION_COOKIE_NAME,
          description:
            'Opaque session token, HttpOnly and SameSite=Lax. Issued by POST /v1/auth/login.',
        },
      },
      schemas: { Error: errorSchema },
    },
    // Document-level default; public routes opt out in the transform below.
    security: [{ sessionCookie: [] }],
    tags: [
      { name: 'auth', description: 'Sessions, signup and sign-in' },
      { name: 'organizations', description: 'Tenants, members and roles' },
      { name: 'invitations', description: 'Inviting people into an organization' },
      { name: 'people', description: 'Employees, departments, attendance and leave' },
      { name: 'work', description: 'Projects, tasks and the dependency graph' },
      { name: 'finance', description: 'Expenses and reimbursement' },
      { name: 'approvals', description: 'The approval engine' },
      { name: 'platform', description: 'Notifications, analytics and health' },
    ],
  },

  /**
   * `schema` is typed as required by @fastify/swagger, but at runtime it is
   * `undefined` for any route that declares none — which is most of them here.
   * The optional access is deliberate: trusting the declared type crashed spec
   * generation with "Cannot read properties of undefined".
   */
  transform: ({ schema, url }: { schema?: FastifySchema; url: string }) => {
    const tag = tagFor(url);
    const isPublic = PUBLIC_ROUTES.some((prefix) => url.startsWith(prefix)) || url === '/';

    return {
      schema: {
        ...schema,
        ...(schema?.tags ? {} : tag ? { tags: [tag] } : {}),
        // An empty array is how OpenAPI expresses "this operation needs no
        // security", overriding the document-level requirement.
        ...(isPublic ? { security: [] } : {}),
      },
      url,
    };
  },
};

/**
 * Interactive docs — development only.
 *
 * The spec itself is harmless, but a browsable console pointed at production is
 * an invitation. The raw JSON stays available at /openapi.json for tooling.
 */
export const swaggerUiOptions: FastifySwaggerUiOptions = {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'list', deepLinking: true },
};

export const openApiEnabled = !env.isProduction;
