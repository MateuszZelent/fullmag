export function classifyFieldRequestFailure({
  failure,
  firstTerminalObservedAt,
  responseAttempts,
  validResponses,
}) {
  const failedUrl = parseUrl(failure.url);
  if (
    !failedUrl ||
    failure.errorText !== "net::ERR_ABORTED" ||
    failure.method !== "GET" ||
    !failedUrl.pathname.endsWith("/meta")
  ) {
    return { intentionalStaleInflightAbort: false };
  }

  const failedIdentity = `${failedUrl.pathname}${failedUrl.search}`;
  const sameAttemptResponse = responseAttempts.find((response) => {
    const responseUrl = parseUrl(response.url);
    return (
      response.attemptId === failure.attemptId &&
      responseUrl !== null &&
      `${responseUrl.pathname}${responseUrl.search}` === failedIdentity &&
      response.receivedAt <= failure.observedAt
    );
  });
  if (!sameAttemptResponse) {
    return { intentionalStaleInflightAbort: false };
  }

  const baselineRevision = numericRevision(sameAttemptResponse.fieldRevision);
  const supersedes = (revision) => {
    const candidateRevision = numericRevision(revision);
    return (
      candidateRevision !== null &&
      (baselineRevision === null
        ? sameAttemptResponse.status === 404
        : candidateRevision > baselineRevision)
    );
  };
  const newerMeta = responseAttempts.some((response) => {
    const responseUrl = parseUrl(response.url);
    return (
      response.receivedAt > failure.observedAt &&
      response.status >= 200 &&
      response.status < 300 &&
      responseUrl !== null &&
      `${responseUrl.pathname}${responseUrl.search}` === failedIdentity &&
      supersedes(response.fieldRevision)
    );
  });
  const fieldPrefix = failedUrl.pathname.slice(0, -"/meta".length);
  const terminalBody =
    firstTerminalObservedAt !== null &&
    validResponses.some((response) => {
      const responseUrl = parseUrl(response.responseUrl);
      return (
        Boolean(response.bodySha256) &&
        response.receivedAt >= firstTerminalObservedAt &&
        response.receivedAt > failure.observedAt &&
        responseUrl?.pathname === `${fieldPrefix}/samples/vector` &&
        supersedes(response.fieldRevision)
      );
    });

  return { intentionalStaleInflightAbort: newerMeta || terminalBody };
}

function parseUrl(value) {
  try {
    return new URL(value, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function numericRevision(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

export function classifyFieldResponseInspectionFailure({
  attemptId,
  errorMessage,
  receivedAt,
  requestFailure,
  requestFailureAttemptId,
  responseUrl,
  validResponses,
}) {
  let pathname = "";
  try {
    pathname = new URL(responseUrl).pathname;
  } catch {
    return { intentionalStaleInflightAbort: false };
  }
  const hasEarlierValidBody = validResponses.some(
    (response) =>
      Boolean(response.bodySha256) && response.receivedAt < receivedAt,
  );
  const bodyWasUnavailableAfterAbort =
    errorMessage.includes("Network.getResponseBody") &&
    errorMessage.includes("No data found for resource with given identifier") &&
    requestFailure?.errorText === "net::ERR_ABORTED" &&
    requestFailureAttemptId === attemptId;

  return {
    intentionalStaleInflightAbort:
      hasEarlierValidBody &&
      bodyWasUnavailableAfterAbort &&
      pathname.endsWith("/samples/vector"),
  };
}

export function observeFirstTerminalAt(
  firstTerminalObservedAt,
  terminal,
  observedAt,
) {
  return firstTerminalObservedAt === null && terminal
    ? observedAt
    : firstTerminalObservedAt;
}

export function isPreterminalPendingOrStaleField(meta, expectedSourceStep) {
  return Boolean(
    meta &&
      ["pending", "stale_complete"].includes(meta.state) &&
      Number.isInteger(meta.source_step) &&
      meta.source_step < expectedSourceStep,
  );
}

export function selectPreterminalFieldResponse(
  fieldResponses,
  firstTerminalObservedAt,
) {
  return (
    fieldResponses.find(
      (response) =>
        firstTerminalObservedAt === null ||
        response.receivedAt < firstTerminalObservedAt,
    ) ?? null
  );
}

export function selectTerminalFieldResponse(
  fieldResponses,
  firstTerminalObservedAt,
) {
  if (firstTerminalObservedAt === null) return null;
  return (
    fieldResponses.findLast(
      (response) => response.receivedAt >= firstTerminalObservedAt,
    ) ?? null
  );
}
