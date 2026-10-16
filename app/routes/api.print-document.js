import {randomUUID} from "node:crypto";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";

export async function action({request}) {
  const {cors} = await authenticate.admin(request);
  if (request.method !== "POST") return cors(new Response(null, {status: 405}));

  const order = await request.json();
  if (!order?.id || !order?.name) {
    return cors(Response.json({error: "Ordine non valido."}, {status: 400}));
  }

  const id = randomUUID();
  await prisma.printDocument.deleteMany({where: {expiresAt: {lt: new Date()}}});
  await prisma.printDocument.create({
    data: {
      id,
      payload: order,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  const printableUrl = new URL("/print/order", request.url);
  printableUrl.searchParams.set("document", id);

  return cors(Response.json({url: printableUrl.toString()}));
}
