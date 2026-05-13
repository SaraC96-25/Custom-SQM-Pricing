import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop") || url.searchParams.get("host")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Custom SQM Pricing</h1>
        <p className={styles.text}>
          Configura sconti per range di metri quadrati sui prodotti Shopify.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>es. wowstampa.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Range mq</strong>. Imposta soglie e percentuali prodotto per
            prodotto.
          </li>
          <li>
            <strong>Quantity selector</strong>. Moltiplica i mq calcolati per la
            quantita scelta nel tema.
          </li>
          <li>
            <strong>Metafield prodotto</strong>. Salva la configurazione dove il
            tema puo leggerla.
          </li>
        </ul>
      </div>
    </div>
  );
}
