/* Copyright 2024 Schibsted Products & Technology AS. Licensed under the terms of the MIT license.
 * See LICENSE.md in the project root.
 */

'use strict';

import { assert, isStr, isNonEmptyString, isUrl } from './utils/validate';
import { urlMapper } from './utils/url';
import { ENDPOINTS, NAMESPACE } from './config/config.js';
import { TinyEmitter as EventEmitter } from 'tiny-emitter';
import RESTClient from './clients/RESTClient';
import Cache from './utils/cache';
import SDKError from './utils/SDKError';
import version from './version';
import type { Environment } from './utils/types';

const globalWindow = () => window;

interface MonetizationOpts {
    clientId: string
    redirectUri: string
    env: Environment,
    sessionDomain: string,
    window: Window
}

interface HasAccessEntry {
    ttl: number,
    productIds: string[],
    entitled: boolean
}

/**
 * Provides features related to monetization
 */
export class Monetization extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.clientId - Mandatory client id
     * @param {string} [options.redirectUri] - Redirect uri
     * @param {string} options.sessionDomain - Example: "https://id.site.com"
     * @param {string} [options.env=PRE] - Schibsted account environment: `PRE`, `PRO` or `PRO_NO`
     * @param {object} [options.window]
     * @throws {SDKError} - If any of options are invalid
     */
    constructor({ clientId, redirectUri, env = 'PRE', sessionDomain, window = globalWindow() }: MonetizationOpts) {
        super();
        // validate options
        assert(isNonEmptyString(clientId), 'clientId parameter is required');

        this.cache = new Cache(() => window && window.sessionStorage);
        this.clientId = clientId;
        this.env = env;
        this.redirectUri = redirectUri;
        this._setSpidServerUrl(env);

        if (sessionDomain) {
            assert(isUrl(sessionDomain), 'sessionDomain parameter is not a valid URL');
            this._setSessionServiceUrl(sessionDomain);
        }
    }

    private readonly cache: Cache;

    private readonly clientId: string;

    private readonly env: Environment;

    private readonly redirectUri: string;

    private spidClient: RESTClient | undefined;

    private sessionServiceClient: RESTClient | undefined;


    /**
     * Set SPiD server URL
     * @private
     * @param {string} env
     * @returns {void}
     */
    private _setSpidServerUrl(env: Environment): void {
        assert(isStr(env), `env parameter is invalid: ${env}`);
        this.spidClient = new RESTClient({
            serverUrl: urlMapper(env, ENDPOINTS.SPiD),
            defaultParams: { client_id: this.clientId, redirect_uri: this.redirectUri },
        });
    }

    /**
     * Set session-service domain
     * @private
     * @param {string} domain - real URL — (**not** 'PRE' style env key)
     * @returns {void}
     */
    private _setSessionServiceUrl(domain: string): void {
        assert(isStr(domain), `domain parameter is invalid: ${domain}`);
        const client_sdrn = `sdrn:${NAMESPACE[this.env]}:client:${this.clientId}`;
        this.sessionServiceClient = new RESTClient({
            serverUrl: domain,
            defaultParams: { client_sdrn, redirect_uri: this.redirectUri, sdk_version: version  },
        });
    }

    /**
     * Checks if the user has access to a set of products or features.
     * @param {array} productIds - which products/features to check
     * @param {number} userId - id of currently logged in user
     * @throws {SDKError} - If the input is incorrect, or a network call fails in any way
     * (this will happen if, say, the user is not logged in)
     * @returns {Object|null} The data object returned from Schibsted account (or `null` if the user
     * doesn't have access to any of the given products/features)
     */
    async hasAccess(productIds: string[], userId: string) {
        if (!this.sessionServiceClient) {
            throw new SDKError('hasAccess can only be called if \'sessionDomain\' is configured');
        }
        if (!userId) {
            throw new SDKError('\'userId\' must be specified');
        }
        if (!Array.isArray(productIds)) {
            throw new SDKError('\'productIds\' must be an array');
        }

        let data: HasAccessEntry;

        const sortedIds = productIds.sort();
        const cacheKey = this._accessCacheKey(productIds, userId);
        const cacheLookup = this.cache.get<HasAccessEntry>(cacheKey);

        if (cacheLookup) {
            data = cacheLookup;
        } else {
            data = await this.sessionServiceClient.get(`/hasAccess/${sortedIds.join(',')}`);
            const expiresSeconds = data.ttl;
            this.cache.set(cacheKey, data, expiresSeconds * 1000);
        }

        if (!data.entitled) {
            return null;
        }
        this.emit('hasAccess', { ids: sortedIds, data });
        return data;
    }

    /**
     * Removes the cached access result.
     * @param {array} productIds - which products/features to check
     * @param {number} userId - id of currently logged in user
     * @returns {void}
     */
    clearCachedAccessResult(productIds: string[], userId: string): void {
        this.cache.delete(this._accessCacheKey(productIds, userId));
    }

    /**
     * Compute "has access" cache key for the given product ids and user id.
     * @param {array} productIds - which products/features to check
     * @param {number} userId - id of currently logged in user
     * @returns {string}
     * @private
     */
    private _accessCacheKey(productIds: string[], userId: string): string {
        return `prd_${productIds.sort()}_${userId}`;
    }

    /**
     * Get the url for the end user to review the subscriptions
     * @param {string} [redirectUri=this.redirectUri]
     * @return {string} - The url to the subscriptions review page
     */
    subscriptionsUrl(redirectUri: string = this.redirectUri): string {
        assert(isUrl(redirectUri), 'subscriptionsUrl(): redirectUri is invalid');
        return this.spidClient!.makeUrl('account/subscriptions', { redirect_uri: redirectUri });
    }

    /**
     * Get the url for the end user to review the products
     * @param {string} [redirectUri=this.redirectUri]
     * @return {string} - The url to the products review page
     */
    productsUrl(redirectUri: string = this.redirectUri): string {
        assert(isUrl(redirectUri), 'productsUrl(): redirectUri is invalid');
        return this.spidClient!.makeUrl('account/products', { redirect_uri: redirectUri });
    }
}

export default Monetization;
