import * as Sentry from '@sentry/sveltekit';
import { KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, KEYCLOAK_ISSUER } from '$env/static/private';
import { PUBLIC_BACKEND_URL } from '$env/static/public';
import { dev } from '$app/environment';

import { error, type Handle, type HandleFetch } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import { SvelteKitAuth } from '@auth/sveltekit';
import Keycloak from '@auth/core/providers/keycloak';
import type { JWT } from '@auth/core/jwt';
import type { User } from '@auth/core/types';

dev ||
	Sentry.init({
		dsn: 'https://a5eca570a1dd3f70e6dbb6a6efadea88@o4506478524301312.ingest.sentry.io/4506557777510400',
		tracesSampleRate: 1
	});

const handleAuth = SvelteKitAuth({
	providers: [
		Keycloak({
			clientId: KEYCLOAK_CLIENT_ID,
			clientSecret: KEYCLOAK_CLIENT_SECRET,
			issuer: KEYCLOAK_ISSUER
		})
	],
	callbacks: {
		jwt: async ({ token, account, user }) => {
			if (account) {
				token.access_token = account.access_token;
				token.access_token_expires = Date.now() + (account.expires_in ?? 0) * 1000;
				token.refresh_token = account.refresh_token;
				token.refresh_token_expires =
					Date.now() + ((account.refresh_expires_in as number) ?? 0) * 1000;
			}
			if (user) {
				token.user = user;
			}
			if (Date.now() < (token.access_token_expires as number) || 0) {
				return token;
			}
			return refreshAccessToken(token);
		},
		signIn: async ({ user, account }) => {
			const url = `${PUBLIC_BACKEND_URL}/api/users`;
			const req = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${account?.access_token}`
				},
				body: JSON.stringify(user)
			});
			return req.ok;
		},
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-expect-error - token is missing from type but still works
		session: async ({ session, token }) => {
			if (session) {
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-expect-error
				session.access_token = token.access_token;
				session.user = token.user as User;
			}
			return session;
		}
	},
	trustHost: true
});

async function refreshAccessToken(token: JWT) {
	if (Date.now() > (token.refresh_token_expires as number) || 0) redirect(302, '/auth/signin');

	const url = new URL(`${KEYCLOAK_ISSUER}/protocol/openid-connect/token`);
	const details = {
		client_id: KEYCLOAK_CLIENT_ID,
		client_secret: KEYCLOAK_CLIENT_SECRET,
		grant_type: ['refresh_token'],
		refresh_token: token.refresh_token as string
	};
	const body = Object.entries(details)
		.map(([key, value]: [string, any]) => {
			const encodedKey = encodeURIComponent(key);
			const encodedValue = encodeURIComponent(value);
			return `${encodedKey}=${encodedValue}`;
		})
		.join('&');

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
		},
		body
	});

	if (!response.ok) {
		error(500, response.statusText);
	}

	const refreshedTokens = await response.json();

	return {
		...token,
		access_token: refreshedTokens.access_token,
		access_token_expires: Date.now() + refreshedTokens.expires_in * 1000,
		refresh_token: refreshedTokens.refresh_token ?? token.refresh_token // Fall back to old refresh token
	};
}

const isAuthenticatedUser: Handle = async ({ event, resolve }) => {
	const session = await event.locals.getSession();
	if (!session?.user && event.url.pathname !== '/') {
		redirect(302, '/auth/signin');
	}
	return resolve(event);
};

export const handleFetch: HandleFetch = async ({ request, event }) => {
	const session = await event.locals.getSession();
	const token = session?.access_token;
	if (!token) {
		return fetch(request);
	}
	request.headers.set('Authorization', `Bearer ${token}`);
	return fetch(request);
};

export const handle = sequence(Sentry.sentryHandle(), handleAuth, isAuthenticatedUser);
export const handleError = Sentry.handleErrorWithSentry();
