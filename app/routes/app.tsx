import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={en}>
        <s-app-nav>
          <s-link href="/app">Custom SQM Pricing</s-link>
          <s-link href="/app/preview-products">Anteprima di stampa</s-link>
          <s-link href="/app/import-tech-specs">Import tech specs</s-link>
          <s-link href="/app/uso-importer">Uso Importer</s-link>
          <s-link href="/app/categoria-prodotto-importer">Categoria prodotto</s-link>
          <s-link href="/app/collection-seo-importer">Collection SEO</s-link>
          <s-link href="/app/tag-importer">TAG Importer</s-link>
          <s-link href="/app/vopo-cleaner">VOPO cleaner</s-link>
        </s-app-nav>
        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
