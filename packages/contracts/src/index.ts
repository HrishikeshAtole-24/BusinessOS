/**
 * @businessos/contracts
 *
 * Types and schemas shared across the API boundary: the API validates inbound
 * requests with them, the web app types its responses from them, and the worker
 * reuses the same domain vocabulary.
 *
 * Kept deliberately free of runtime dependencies beyond Zod. Nothing here may
 * import Prisma, Fastify or React — the moment it does, the boundary leaks.
 */

export * from './auth.js';
export * from './errors.js';
export * from './pagination.js';
export * from './permissions.js';
