export function resolveDevServerPublicOrigin(host, listenPort, publishedPort) {
  const port = String(publishedPort ?? listenPort);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`Invalid Fullmag web public port: ${port}`);
  }
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}
