/**
 * Test-only module stub.
 *
 * `@deepseek-ai/dsh-tools` is a peer dependency supplied by the running host,
 * not something this package installs, so a bare checkout cannot import it.
 * The hook below redirects exactly that specifier to `define-tool-stub.mjs`;
 * every other import resolves normally.
 *
 * Loaded with `node --import ./test/support/stub-tools.mjs`.
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const STUB = pathToFileURL(join(import.meta.dirname, 'define-tool-stub.mjs')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
