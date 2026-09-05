import { httpRouter } from 'convex/server';

// Auth v2 components mount /auth/.well-known/jwks.json and
// /oauth/google/callback through httpPrefix in convex.config.ts. Refresh and
// sign-out use the validated auth mutations directly from the SPA client.
import { registerRoutes } from '@convex-dev/stripe';
import { components } from './_generated/api';
import { reconcileCustomer } from './billing';
const http = httpRouter();
registerRoutes(http, components.stripe, {webhookPath:'/stripe/webhook', onEvent:async(ctx,event)=>{
  if (!['customer.subscription.', 'invoice.', 'checkout.session.'].some(prefix=>event.type.startsWith(prefix))) return;
  const object = event.data.object;
  if ('customer' in object && object.customer) {
    const id = typeof object.customer === 'string' ? object.customer : object.customer.id;
    await reconcileCustomer(ctx,id);
  }
}});
export default http;
