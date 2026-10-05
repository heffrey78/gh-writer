import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Raw HTTP to the server, so tests control Host, Origin and the rest the way an attacker could. */
export function send(
  port: number,
  path: string,
  { method = "GET", headers = {}, agent, body }: { method?: string; headers?: Record<string, string>; agent?: Agent | false; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, agent, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** The events of a finished text/event-stream body. */
export function sseEvents(body: string): { event: string; data: unknown }[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      return { event, data: JSON.parse(data) as unknown };
    });
}
