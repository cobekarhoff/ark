/** The hub's stable name: one or more lowercase labels (1 to 63 of `[a-z0-9-]`, no edge `-`), then `localhost`. */
export const hubNamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost$/;

export const isHubName = (name: string): boolean => hubNamePattern.test(name);

/** The port the name proxy listens on. */
export const proxyPort = 80;
