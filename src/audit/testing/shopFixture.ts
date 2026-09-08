import type { IncomingMessage, ServerResponse } from 'node:http';
import { html, type FixtureRoute, type RouteHandler } from './fixtureServer.js';

/**
 * A minimal but *stateful* fake Shopify storefront for the cart and checkout
 * tests. The cart flow is the one part of the audit that changes the shop's
 * state, so it cannot be tested against static HTML: adding, re-quantifying and
 * removing have to actually take effect for the checks to mean anything.
 */

export interface ShopFlags {
  /** The add-to-cart button is inert, as on a shop with broken theme JS. */
  brokenAddToCart?: boolean;
  noQuantityControl?: boolean;
  noRemoveControl?: boolean;
  noCheckoutButton?: boolean;
  /** Status the checkout page answers with. */
  checkoutStatus?: number;
  /** Drops `/cart.js`, the way a non-Shopify shop would. */
  noCartApi?: boolean;
}

export interface ShopFixture {
  routes: Record<string, FixtureRoute | RouteHandler>;
  /** Line quantity currently in the cart. */
  quantity: () => number;
}

const PRICE = 34900; // grosze, as Shopify stores money

export function createShopFixture(flags: ShopFlags = {}): ShopFixture {
  const state = { quantity: 0 };

  const send = (res: ServerResponse, body: string, status = 200): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const redirect = (res: ServerResponse, location: string): void => {
    res.writeHead(302, { location });
    res.end();
  };

  const cartPage = (): string => {
    if (state.quantity === 0) return html('<main><h1>Twój koszyk jest pusty</h1></main>');
    return html(`<main>
      <h1>Koszyk</h1>
      <table class="cart-items"><tr class="cart-item">
        <td><a href="/products/but">Buty skórzane</a></td>
        <td class="price">${((PRICE * state.quantity) / 100).toFixed(2)} zł</td>
        <td>${
          flags.noQuantityControl
            ? `<span>${state.quantity}</span>`
            : `<form action="/cart/change" method="post">
                 <input name="quantity" type="number" value="${state.quantity}">
                 <button type="submit">Aktualizuj</button>
               </form>`
        }</td>
        <td>${
          flags.noRemoveControl
            ? ''
            : '<a class="cart-remove" href="/cart/change?quantity=0">Usuń</a>'
        }</td>
      </tr></table>
      <div class="shipping-calculator">Szacunkowy koszt dostawy</div>
      ${flags.noCheckoutButton ? '' : '<form action="/checkout" method="get"><button name="checkout">Przejdź do kasy</button></form>'}
    </main>`);
  };

  const readQuantity = (req: IncomingMessage, body: string): number => {
    const source = req.method === 'POST' ? body : ((req.url ?? '').split('?')[1] ?? '');
    const value = new URLSearchParams(source).get('quantity');
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 1;
  };

  const withBody =
    (handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): RouteHandler =>
    (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => handler(req, res, body));
    };

  const routes: Record<string, FixtureRoute | RouteHandler> = {
    '/': {
      body: html(`<header><nav>
          <a href="/collections/all">Sklep</a><a href="/pages/kontakt">Kontakt</a><a href="/cart">Koszyk</a>
        </nav><form action="/search"><input type="search" name="q"></form></header>
        <main><h1>Sklep</h1></main>
        <footer><a href="/policies/regulamin">Regulamin</a></footer>`),
    },
    '/collections/all': {
      body: html(`<ul class="grid"><li class="product-card">
        <a href="/products/but">Buty skórzane</a><span class="price">349,00 zł</span>
      </li></ul>`),
    },
    '/products/but': {
      body: html(`<main>
        <h1>Buty skórzane</h1><span class="price">349,00 zł</span>
        <form action="/cart/add" method="post">
          <input name="quantity" type="number" value="1">
          <button name="add" ${flags.brokenAddToCart ? 'type="button"' : 'type="submit"'}>Dodaj do koszyka</button>
        </form>
      </main>`),
    },
    '/cart/add': withBody((_req, res) => {
      state.quantity += 1;
      redirect(res, '/cart');
    }),
    '/cart/change': withBody((req, res, body) => {
      state.quantity = readQuantity(req, body);
      redirect(res, '/cart');
    }),
    '/cart': (_req, res) => send(res, cartPage()),
    '/checkout': (_req, res) => {
      const status = flags.checkoutStatus ?? 200;
      send(
        res,
        html(`<main><h1>Kasa</h1>
          <form>
            <input type="email" name="email" required placeholder="E-mail">
            <select name="country"><option>Polska</option></select>
            <input name="address" required>
            <div class="payment-methods">BLIK, Przelewy24, karta</div>
            <div class="shipping-methods">Kurier DPD — 15,00 zł</div>
          </form></main>`),
        status,
      );
    },
  };

  if (!flags.noCartApi) {
    routes['/cart.js'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          item_count: state.quantity,
          total_price: PRICE * state.quantity,
          items: state.quantity
            ? [{ key: 'but:1', quantity: state.quantity, title: 'Buty skórzane' }]
            : [],
        }),
      );
    };
  }

  return { routes, quantity: () => state.quantity };
}
