/**
 * @businessos/domain
 *
 * Domain logic with no transport or persistence dependencies: password
 * hashing, value objects, state machines and business rules. Anything here
 * must be usable from the API, the worker and the seed alike, which is why it
 * imports neither Fastify nor Prisma.
 */

export * from './password.js';
