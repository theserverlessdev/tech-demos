/** How long a gatekeeper action stays pending before it expires. */
export const APPROVAL_TIMEOUT_MS = 90_000;
/** WEB.getJson aborts the outbound fetch after this. */
export const WEB_FETCH_TIMEOUT_MS = 8_000;
/** Slack for a gadget method that does not wait on the approval queue. */
export const GADGET_METHOD_TIMEOUT_MS = 20_000;

/**
 * Agent/platform wrapper around a gadget method. A WEB-bound call can sit in
 * `authorize()` for the full approval window, then spend up to the fetch timeout
 * on the network, then do a little local work. The 20s method-only budget is
 * too short for "refresh() does not return until a person decides".
 */
export const GADGET_CALL_TIMEOUT_MS = APPROVAL_TIMEOUT_MS + WEB_FETCH_TIMEOUT_MS + GADGET_METHOD_TIMEOUT_MS;
