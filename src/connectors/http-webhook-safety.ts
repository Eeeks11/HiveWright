import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

export class HttpWebhookBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpWebhookBlockedError";
  }
}

export interface HttpWebhookDestination {
  url: URL;
  hostname: string;
  addresses: string[];
}

type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface ValidatedHttpRequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

interface ValidatedHttpDispatchResult {
  response: Response;
  remoteAddress: string | null;
}

type ValidatedHttpDispatch = (
  destination: HttpWebhookDestination,
  address: string,
  options: ValidatedHttpRequestOptions,
  label: string,
) => Promise<ValidatedHttpDispatchResult>;

class HttpWebhookResponseTooLargeError extends Error {
  constructor(label: string, maxResponseBytes: number) {
    super(`${label} response exceeded ${maxResponseBytes} bytes`);
    this.name = "HttpWebhookResponseTooLargeError";
  }
}

type PublicAddressPredicate = (address: string) => boolean;

let dnsLookup: DnsLookup = dns.lookup as DnsLookup;
let httpDispatch: ValidatedHttpDispatch = dispatchValidatedHttpRequest;
let publicAddressPredicate: PublicAddressPredicate = isPublicIpAddress;

export function setHttpWebhookDnsLookupForTests(lookupForTests: DnsLookup | null): void {
  dnsLookup = lookupForTests ?? (dns.lookup as DnsLookup);
}

export function setHttpWebhookDispatchForTests(dispatchForTests: ValidatedHttpDispatch | null): void {
  httpDispatch = dispatchForTests ?? dispatchValidatedHttpRequest;
}

export function setHttpWebhookPublicAddressPredicateForTests(
  predicateForTests: PublicAddressPredicate | null,
): void {
  publicAddressPredicate = predicateForTests ?? isPublicIpAddress;
}

export function parseAllowedHostnames(value: unknown): string[] {
  if (typeof value !== "string") return [];

  const normalized = value
    .split(/[\s,]+/)
    .map(normalizeHostname)
    .filter((hostname): hostname is string => Boolean(hostname));

  return Array.from(new Set(normalized));
}

export async function validateHttpWebhookDestination(
  rawUrl: string,
  allowedHostnamesConfig: unknown,
  label = "http-webhook",
): Promise<HttpWebhookDestination> {
  const allowedHostnames = parseAllowedHostnames(allowedHostnamesConfig);
  if (allowedHostnames.length === 0) {
    throw new HttpWebhookBlockedError(
      `${label} is disabled until Allowed hostnames is configured`,
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpWebhookBlockedError(`${label} target URL is invalid`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpWebhookBlockedError(`${label} only supports HTTP(S) URLs`);
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || !allowedHostnames.includes(hostname)) {
    throw new HttpWebhookBlockedError(
      `${label} hostname ${url.hostname} is not in Allowed hostnames`,
    );
  }

  let answers: Array<{ address: string }>;
  try {
    answers = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new HttpWebhookBlockedError(
      `${label} DNS resolution failed for ${hostname}: ${(error as Error).message}`,
    );
  }

  if (answers.length === 0) {
    throw new HttpWebhookBlockedError(`${label} DNS returned no addresses for ${hostname}`);
  }

  const addresses = answers.map((answer) => normalizeIpAddress(answer.address));
  const unsafeAddress = addresses.find((address) => !publicAddressPredicate(address));
  if (unsafeAddress) {
    throw new HttpWebhookBlockedError(
      `${label} destination resolved to unsafe address ${unsafeAddress}`,
    );
  }

  return { url, hostname, addresses };
}

export async function fetchValidatedHttpWebhookDestination(
  destination: HttpWebhookDestination,
  options: ValidatedHttpRequestOptions,
  label = "http-webhook",
): Promise<Response> {
  let lastError: Error | null = null;
  const canRetryDispatch = isIdempotentHttpMethod(options.method);

  for (const address of destination.addresses) {
    try {
      const result = await httpDispatch(destination, address, options, label);
      const remoteAddress = result.remoteAddress ? normalizeIpAddress(result.remoteAddress) : null;
      if (!remoteAddress || !destination.addresses.includes(remoteAddress) || !publicAddressPredicate(remoteAddress)) {
        throw new HttpWebhookBlockedError(
          `${label} connected to unvalidated address ${remoteAddress ?? "unknown"}`,
        );
      }
      return result.response;
    } catch (error) {
      lastError = error as Error;
      if (error instanceof HttpWebhookBlockedError) throw error;
      if (error instanceof HttpWebhookResponseTooLargeError) throw error;
      if (!canRetryDispatch) {
        throw new HttpWebhookBlockedError(
          `${label} connection failed for validated address ${address}: ${lastError.message}`,
        );
      }
    }
  }

  throw new HttpWebhookBlockedError(
    `${label} connection failed for all validated addresses: ${lastError?.message ?? "unknown error"}`,
  );
}

function isIdempotentHttpMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"].includes(method.toUpperCase());
}

function dispatchValidatedHttpRequest(
  destination: HttpWebhookDestination,
  address: string,
  options: ValidatedHttpRequestOptions,
  label: string,
): Promise<ValidatedHttpDispatchResult> {
  return new Promise((resolve, reject) => {
    const transport = destination.url.protocol === "https:" ? https : http;
    const headers = {
      ...(options.headers ?? {}),
      Host: buildHostHeader(destination.url, destination.hostname),
    };
    let settled = false;
    let remoteAddress: string | null = null;

    const request = transport.request({
      protocol: destination.url.protocol,
      hostname: address,
      port: destination.url.port || undefined,
      path: `${destination.url.pathname}${destination.url.search}`,
      method: options.method,
      headers,
      servername: destination.hostname,
      agent: false,
      signal: options.signal,
      lookup: (_hostname, _lookupOptions, callback) => {
        callback(null, address, net.isIP(address) === 6 ? 6 : 4);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      res.on("data", (chunk: Buffer) => {
        bytesRead += chunk.byteLength;
        if (options.maxResponseBytes !== undefined && bytesRead > options.maxResponseBytes) {
          if (settled) return;
          settled = true;
          const error = new HttpWebhookResponseTooLargeError(label, options.maxResponseBytes);
          res.destroy(error);
          request.destroy(error);
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const part of value) responseHeaders.append(key, part);
          } else if (typeof value === "string") {
            responseHeaders.set(key, value);
          }
        }
        resolve({
          response: new Response(Buffer.concat(chunks), {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          }),
          remoteAddress,
        });
      });
      res.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });

    request.on("socket", (socket) => {
      const recordRemoteAddress = () => {
        remoteAddress = normalizeIpAddress(socket.remoteAddress ?? "");
        if (!destination.addresses.includes(remoteAddress) || !publicAddressPredicate(remoteAddress)) {
          request.destroy(new HttpWebhookBlockedError(
            `${label} connected to unvalidated address ${remoteAddress || "unknown"}`,
          ));
        }
      };
      if (socket.connecting === false) {
        recordRemoteAddress();
      } else {
        socket.once("connect", recordRemoteAddress);
        socket.once("secureConnect", recordRemoteAddress);
      }
    });

    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    request.end(options.body);
  });
}

function buildHostHeader(url: URL, hostname: string): string {
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return url.port && url.port !== defaultPort ? `${hostname}:${url.port}` : hostname;
}

function normalizeHostname(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) return null;

  try {
    return new URL(`http://${trimmed}`).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

function normalizeIpAddress(address: string): string {
  const ipv4Mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return ipv4Mapped ? ipv4Mapped[1] : address;
}

function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  const family = net.isIP(normalized);
  if (family === 4) return isPublicIpv4Address(normalized);
  if (family === 6) return isPublicIpv6Address(normalized);
  return false;
}

function isPublicIpv4Address(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = octets;
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && octets[2] === 113) return false;
  if (a >= 224) return false;

  return true;
}

function isPublicIpv6Address(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;

  const firstHextetText = normalized.startsWith("::")
    ? "0"
    : normalized.split(":")[0];
  const firstHextet = Number.parseInt(firstHextetText, 16);
  if (!Number.isFinite(firstHextet)) return false;

  if ((firstHextet & 0xffc0) === 0xfe80) return false;
  if ((firstHextet & 0xfe00) === 0xfc00) return false;
  if ((firstHextet & 0xff00) === 0xff00) return false;
  if ((firstHextet & 0xe000) !== 0x2000) return false;
  if (normalized.startsWith("2001:db8:") || normalized === "2001:db8::") {
    return false;
  }

  return true;
}
