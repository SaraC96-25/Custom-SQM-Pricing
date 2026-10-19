import {randomUUID} from "node:crypto";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function withCorsHeaders(response) {
  Object.entries(CORS_HEADERS).forEach(([name, value]) => {
    response.headers.set(name, value);
  });
  return response;
}

export async function loader({request}) {
  if (request.method === "OPTIONS") {
    return new Response(null, {status: 204, headers: CORS_HEADERS});
  }

  // Lightweight warm-up: the order block pings this when the order page opens,
  // so the server (Render free plan sleeps when idle) is awake before "Stampa ordine".
  return new Response(null, {
    status: 204,
    headers: {...CORS_HEADERS, "Cache-Control": "no-store"},
  });
}

export async function action({request}) {
  const {cors} = await authenticate.admin(request);
  if (request.method !== "POST") {
    return cors(withCorsHeaders(new Response(null, {status: 405})));
  }

  const order = await request.json();
  if (!order?.id || !order?.name) {
    return cors(withCorsHeaders(Response.json({error: "Ordine non valido."}, {status: 400})));
  }

  const id = randomUUID();
  // Cleanup of expired documents runs in background instead of delaying the response.
  prisma.printDocument.deleteMany({where: {expiresAt: {lt: new Date()}}}).catch((error) => {
    console.error("Unable to clean expired print documents", error);
  });
  await prisma.printDocument.create({
    data: {
      id,
      payload: order,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  const printableUrl = new URL("/print/order", process.env.SHOPIFY_APP_URL || request.url);
  printableUrl.protocol = "https:";
  printableUrl.searchParams.set("document", id);

  return cors(withCorsHeaders(Response.json({url: printableUrl.toString()})));
}
