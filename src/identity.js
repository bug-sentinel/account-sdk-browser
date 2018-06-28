/* Copyright 2018 Schibsted Products & Technology AS. Licensed under the terms of the MIT license.
 * See LICENSE.md in the project root.
 */

'use strict';

import { assert, isStr, isNonEmptyString, isObject, isUrl, isStrIn } from './validate';
import { cloneDeep } from './object';
import { urlMapper } from './url';
import { ENDPOINTS } from './config';
import EventEmitter from 'tiny-emitter';
import JSONPClient from './JSONPClient';
import Cache from './cache';
import * as popup from './popup';
import RESTClient from './RESTClient';
import SDKError from './SDKError';
import * as spidTalk from './spidTalk';

/**
 * @typedef {object} Identity#HasSessionSuccessResponse
 * @property {boolean} result - Is the user connected to the merchant? (it means that the merchant
 * id is in the list of merchants listed of this user in the database)? Example: false
 * @property {string} userStatus - Example: 'notConnected' or 'connected'
 * @property {string} baseDomain - Example: 'localhost'
 * @property {string} id - Example: '58eca10fdbb9f6df72c3368f'
 * @property {number} userId - Example: 37162
 * @property {string} uuid - Example: 'b3b23aa7-34f2-5d02-a10e-5a3455c6ab2c'
 * @property {string} sp_id - Example: 'eyJjbGllbnRfaWQ...'
 * @property {number} expiresIn - Example: 30 * 60 * 1000 (for 30 minutes)
 * @property {number} serverTime - Example: 1506285759
 * @property {string} sig - Example: 'NCdzXaz4ZRb7...' The sig parameter is a concatenation of an
 * HMAC SHA-256 signature string, a dot (.) and a base64url encoded JSON object (session). @see
 * http://techdocs.spid.no/sdks/js/response-signature-and-validation/
 * @property {string} displayName - (Only for connected users) Example: 'batman'
 * @property {string} givenName - (Only for connected users) Example: 'Bruce'
 * @property {string} familyName - (Only for connected users) Example: 'Wayne'
 * @property {string} gender - (Only for connected users) Example: 'male', 'female', 'undisclosed'
 * @property {string} photo - (Only for connected users) Example:
 * 'http://www.srv.com/some/picture.jpg'
 * @property {boolean} tracking - (Only for connected users)
 * @property {boolean} clientAgreementAccepted - (Only for connected users)
 * @property {boolean} defaultAgreementAccepted - (Only for connected users)
 */

/**
 * Emitted when an error happens (useful for debugging)
 * @event Identity#error
 */

/**
 * @typedef {object} Identity#HasSessionFailureResponse
 * @property {object} error
 * @property {number} error.code - Typically an HTTP response code. Example: 401
 * @property {string} error.description - Example: "No session found!"
 * @property {string} error.type - Example: "UserException"
 * @property {object} response
 * @property {string} response.baseDomain - Example: "localhost"
 * @property {number} response.expiresIn - Time span in milliseconds. Example: 30 * 60 * 1000 (for 30 minutes)
 * @property {boolean} response.result
 * @property {number} response.serverTime - Server time in seconds since the Unix Epoch. Example: 1506287788
 */

const HAS_SESSION_CACHE_KEY = 'hasSession-cache';
const globalWindow = () => window;

/**
 * Get type and value of something
 * @private
 * @param {string} thing
 * @returns {Array} Tuple of [type, value]
 */
function inspect(thing) {
    if (thing === null) {
        return [typeof thing, `${thing}`];
    }
    return [thing.constructor.name, thing.valueOf()];
}

/**
 * Provides Identity functionalty to a web page
 */
export class Identity extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.clientId - Example: "1234567890abcdef12345678"
     * @param {string} [options.redirectUri] - Example: "https://site.com"
     * @param {string} [options.env='PRE'] - Schibsted account environment: `PRE`, `PRO` or `PRO_NO`
     * @param {function} [options.log] - A function that receives debug log information. If not set,
     * no logging will be done
     * @throws {SDKError} - If any of options are invalid
     */
    constructor({ clientId, redirectUri, env = 'PRE', log, window = globalWindow() }) {
        super();
        assert(isNonEmptyString(clientId), 'clientId parameter is required');
        assert(isObject(window), 'The reference to window is missing');
        assert(!redirectUri || isUrl(redirectUri), 'redirectUri parameter is invalid');

        spidTalk.emulate(window);
        this._sessionInitiatedSent = false;
        this.window = window;
        this.clientId = clientId;
        this._initCache();
        this.redirectUri = redirectUri;
        this.log = log;

        // Internal hack: set to false to always refresh from hassession
        this._enableSessionCaching = true;

        // Old session
        this._session = {};

        this._setSpidServerUrl(env);
        this._setBffServerUrl(env);
        this._setOauthServerUrl(env);
        this._setHasSessionServerUrl(env);
    }

    /**
     * Set SPiD server URL
     * @private
     * @param {string} url - real URL or 'PRE' style key
     * @returns {void}
     */
    _setSpidServerUrl(url) {
        assert(isStr(url), `url parameter is invalid: ${url}`);
        this._spid = new JSONPClient({
            serverUrl: urlMapper(url, ENDPOINTS.SPiD),
            log: this.log,
            defaultParams: { client_id: this.clientId, redirect_uri: this.redirectUri },
        });
    }

    /**
     * Set OAuth server URL
     * @private
     * @param {string} url - real URL or 'PRE' style key
     * @returns {void}
     */
    _setOauthServerUrl(url) {
        assert(isStr(url), `url parameter is invalid: ${url}`);
        this._oauthService = new RESTClient({
            serverUrl: urlMapper(url, ENDPOINTS.SPiD),
            log: this.log,
            defaultParams: { client_id: this.clientId, redirect_uri: this.redirectUri },
        });
    }

    /**
     * Set BFF server URL - real URL or 'PRE' style key
     * @private
     * @param {string} url
     * @returns {void}
     */
    _setBffServerUrl(url) {
        assert(isStr(url), `url parameter is invalid: ${url}`);
        this._bffService = new RESTClient({
            serverUrl: urlMapper(url, ENDPOINTS.BFF),
            log: this.log,
            defaultParams: { client_id: this.clientId, redirect_uri: this.redirectUri },
        });
    }

    /**
     * Set HasSession server URL - real URL or 'PRE' style key
     * @private
     * @param {string} url
     * @returns {void}
     */
    _setHasSessionServerUrl(url) {
        assert(isStr(url), `url parameter is invalid: ${url}`);
        this._hasSession = new JSONPClient({
            serverUrl: urlMapper(url, ENDPOINTS.HAS_SESSION),
            log: this.log,
            defaultParams: { client_id: this.clientId, redirect_uri: this.redirectUri },
        });
    }

    /**
     * Emits the relevant events based on the previous and new reply from hassession
     * @private
     * @param {object} previous
     * @param {object} current
     * @returns {void}
     */
    _emitSessionEvent(previous, current) {
        /**
         * Emitted when the user is logged in (This happens as a result of calling
         * {@link Identity#hasSession}, so it is also emitted if the user was previously logged in)
         * @event Identity#login
         */
        if (current.userId) {
            this.emit('login', current);
        }
        /**
         * Emitted when the user logged out
         * @event Identity#logout
         */
        if (previous.userId && !current.userId) {
            this.emit('logout', current);
        }
        /**
         * Emitted when the user is changed. This happens as a result of calling
         * {@link Identity#hasSession}, and is emitted if there was a user both before and after
         * this invocation, and the userId has now changed
         * @event Identity#userChange
         */
        if (previous.userId && current.userId && previous.userId !== current.userId) {
            this.emit('userChange', current);
        }
        if (previous.userId || current.userId) {
            /**
             * Emitted when the session is changed. More accurately, this event is emitted if there
             * was a logged-in user either before or after {@link Identity#hasSession} was called.
             * In practice, this means the event is emitted a lot
             * @event Identity#sessionChange
             */
            this.emit('sessionChange', current);
        } else {
            /**
             * Emitted when there is no logged-in user. More specifically, it means that there was
             * no logged-in user neither before nor after {@link Identity#hasSession} was called
             * @event Identity#notLoggedin
             */
            this.emit('notLoggedin', current);
        }
        /**
         * Emitted when the session is first created
         * @event Identity#sessionInit
         */
        if (current.userId && !this._sessionInitiatedSent) {
            this._sessionInitiatedSent = true;
            this.emit('sessionInit', current);
        }
        /**
         * Emitted when the user status changes. This happens as a result of calling
         * {@link Identity#hasSession}
         * @event Identity#statusChange
         */
        if (previous.userStatus !== current.userStatus) {
            this.emit('statusChange', current);
        }
    }

    /**
     * Close this.popup if it exists and is open
     * @private
     * @returns {void}
     */
    _closePopup() {
        if (this.popup) {
            if (!this.popup.closed) {
                this.popup.close();
            }
            this.popup = null;
        }
    }

    /**
     * Create a fresh cache for this instance
     * @private
     * @returns {void}
     */
    _initCache() {
        this.cache = new Cache(this.window && this.window.localStorage);
    }

    /**
     * Set the Varnish cookie (`SP_ID`) when hasSession() is called. Note that most browsers require
     * that you are on a "real domain" for this to work — so, **not** `localhost`
     * @returns {void}
     */
    enableVarnishCookie() {
        this.setVarnishCookie = true;
        this._initCache();
    }

    /**
     * Set the Varnish cookie if configured
     * @private
     * @param {HasSessionSuccessResponse} sessionData
     * @returns {void}
     */
    _maybeSetVarnishCookie(sessionData) {
        if (!this.setVarnishCookie) {
            return;
        }
        const date = new Date();
        if (typeof sessionData.expiresIn === 'number' && sessionData.expiresIn > 0) {
            date.setTime(date.getTime() + (sessionData.expiresIn * 1000));
        } else {
            date.setTime(0);
        }
        // If the domain is missing or of the wrong type, we'll use document.domain
        const domain = (typeof sessionData.baseDomain === 'string')
            ? sessionData.baseDomain
            : (document.domain || '');
        const cookie = [
            `SP_ID=${sessionData.sp_id}`,
            `expires=${date.toUTCString()}`,
            `path=/`,
            `domain=.${domain}`
        ].join('; ');
        document.cookie = cookie;
    }

    /**
     * @summary Queries the hassession endpoint and returns information about the status of the user
     * @description When we send a request to this endpoint, cookies sent along with the request
     * determines the status of the user. If the user is not currently logged in, but has a cookie
     * with the "Remember me" flag switched on, calling this function will attempt to automatically
     * perform a login on the user
     * @param {boolean} [autologin=true] - Set this to `false` if you do **not** want the auto-login
     * to happen
     * @throws {SDKError} - If the call to the hasSession service fails in any way (this will happen
     * if, say, the user is not logged in)
     * @fires Identity#login
     * @fires Identity#logout
     * @fires Identity#userChange
     * @fires Identity#sessionChange
     * @fires Identity#notLoggedin
     * @fires Identity#sessionInit
     * @fires Identity#statusChange
     * @fires Identity#error
     * @return {Identity#HasSessionSuccessResponse|Identity#HasSessionFailureResponse}
     */
    async hasSession(autologin = true) {
        if (typeof autologin !== 'boolean') {
            const [type, value] = inspect(autologin);
            throw new SDKError(`Parameter 'autologin' must be boolean, was: "${type}:${value}"`);
        }
        if (this._enableSessionCaching) {
            // Try to resolve from cache (it has a TTL)
            const cachedData = this.cache.get(HAS_SESSION_CACHE_KEY);
            if (cachedData) {
                this._emitSessionEvent(this._session, cachedData);
                return cachedData;
            }
        }

        try {
            const autoLoginConverted = autologin ? 1 : 0;
            let data = await this._hasSession.get('rpc/hasSession.js', { autologin: autoLoginConverted });
            if (isObject(data.error) && data.error.type === 'LoginException') {
                data = await this._spid.get('ajax/hasSession.js', { autologin: autoLoginConverted });
            }
            if (data.result) {
                this.cache.set(HAS_SESSION_CACHE_KEY, data, data.expiresIn * 1000);
            }
            if (data.error) {
                throw new SDKError('HasSession endpoint returned an error', data.error);
            }
            this._maybeSetVarnishCookie(data);
            this._emitSessionEvent(this._session, data);
            this._session = data;
            return data;
        } catch (err) {
            this.emit('error', err);
            throw new SDKError('HasSession failed', err);
        }
    }

    /**
     * @summary Allows the client app to check if the user is logged in to Schibsted account
     * @description This function calls {@link Identity#hasSession} internally and thus has the side
     * effect that it might perform an auto-login on the user
     * @return {boolean}
     */
    async isLoggedIn() {
        try {
            const data = await this.hasSession();
            return 'result' in data;
        } catch (_) {
            return false;
        }
    }

    /**
     * @summary Allows the caller to check if the current user is connected to the client_id in
     * Schibsted account. Being connected means that the user has agreed for their account to be
     * used by your web app and have accepted the required terms
     * @description This function calls {@link Identity#hasSession} internally and thus has the side
     * effect that it might perform an auto-login on the user
     * @summary Check if the user is connected to the client_id
     * @return {boolean}
     */
    async isConnected() {
        try {
            const data = await this.hasSession();
            // if data is not an object, the promise will fail.
            // if the result is present, it's boolean. But if it's not, it should be assumed false.
            return !!data.result;
        } catch (_) {
            return false;
        }
    }

    /**
     * @summary Returns information about the user
     * @description This function calls {@link Identity#hasSession} internally and thus has the side
     * effect that it might perform an auto-login on the user
     * @throws {SDKError} If the user isn't connected to the merchant
     * @throws {SDKError} If we couldn't get the user
     * @return {HasSessionSuccessResponse}
     */
    async getUser() {
        const user = await this.hasSession();
        if (!user.result) {
            throw new SDKError('The user is not connected to this merchant');
        }
        return cloneDeep(user);
    }

    /**
     * @summary In Schibsted account, there are two ways of identifying a user; the `userId` and the
     * `uuid`. There are reasons for them both existing. The `userId` is a numeric identifier, but
     * since Schibsted account is deployed separately in Norway and Sweden, there are a lot of
     * duplicates. The `userId` was introduced early, so many sites still need to use them for
     * legacy reasons. The `uuid` is universally unique, and so — if we could disregard a lot of
     * Schibsted components depending on the numeric `userId` — it would be a good identifier to use
     * @description This function calls {@link Identity#hasSession} internally and thus has the side
     * effect that it might perform an auto-login on the user
     * @throws {SDKError} If the user isn't connected to the merchant
     * @return {string} The `userId` field (not to be confused with the `uuid`)
     */
    async getUserId() {
        const user = await this.hasSession();
        if (user.userId && user.result) {
            return user.userId;
        }
        throw new SDKError('The user is not connected to this merchant');
    }

    /**
     * @summary In Schibsted account, there are two ways of identifying a user; the `userId` and the
     * `uuid`. There are reasons for them both existing. The `userId` is a numeric identifier, but
     * since Schibsted account is deployed separately in Norway and Sweden, there are a lot of
     * duplicates. The `userId` was introduced early, so many sites still need to use them for
     * legacy reasons. The `uuid` is universally unique, and so — if we could disregard a lot of
     * Schibsted components depending on the numeric `userId` — it would be a good identifier to use
     * @description This function calls {@link Identity#hasSession} internally and thus has the side
     * effect that it might perform an auto-login on the user
     * @throws {SDKError} If the user isn't connected to the merchant
     * @return {string} The `uuid` field (not to be confused with the `userId`)
     */
    async getUserUuid() {
        const user = await this.hasSession();
        if (user.uuid && user.result) {
            return user.uuid;
        }
        throw new SDKError('The user is not connected to this merchant');
    }

    /**
     * @summary Retrieve the sp_id (Varnish ID)
     * @description This function calls {@link Identity#hasSession} internally and thus has the side
     * effect that it might perform an auto-login on the user
     * @todo Is this an accurate description?
     * @return {string|null} - The sp_id string or null (if the server didn't return it)
     */
    async getSpId() {
        try {
            const user = await this.hasSession();
            return user.sp_id || null;
        } catch (_) {
            return null;
        }
    }

    /**
     * If a popup is desired, this function needs to be called in response to a user event (like
     * click or tap) in order to work correctly. Otherwise the popup will be blocked by the
     * browser's popup blockers and has to be explicitly authorized to be shown.
     * @summary Perform a login, either using a full-page redirect or a popup
     * @see https://tools.ietf.org/html/rfc6749#section-4.1.1
     * @param {object} options
     * @param {string} [options.acrValues] - Authentication Context Class Reference Values. If
     * omitted, the user will be asked to authenticate using username+password. 'otp-email' means
     * one time password using email. 'otp-sms' means one time password using sms
     * @param {string} options.state - An opaque value used by the client to maintain state between
     * the request and callback. It's also recommended to prevent CSRF
     * @see https://tools.ietf.org/html/rfc6749#section-10.12
     * @param {string} [options.scope='openid'] - The OAuth scopes for the tokens. This is a list of
     * scopes, separated by space. If the list of scopes contains `openid`, the generated tokens
     * includes the id token which can be useful for getting information about the user. Omitting
     * scope is allowed, while `invalid_scope` is returned when the client asks for a scope you
     * aren’t allowed to request.
     * @see https://tools.ietf.org/html/rfc6749#section-3.3
     * @param {string} [options.redirectUri=this.redirectUri] - Redirect uri that will receive the
     * code. Must exactly match a redirectUri from your client in self-service
     * @param {boolean} [options.preferPopup=false] - Should we try to open a popup window?
     * @param {boolean} [options.newFlow=true] - Should we try the new GDPR-safe flow or the
     * legacy/stable SPiD flow?
     * @param {string} [options.loginHint=''] - user email hint
     * @return {Window|null} - Reference to popup window if created (or `null` otherwise)
     */
    login({
        acrValues,
        state,
        scope = 'openid',
        redirectUri = this.redirectUri,
        preferPopup = false,
        newFlow = true,
        loginHint = ''
    }) {
        this._closePopup();
        const url = this.loginUrl(state, acrValues, scope, redirectUri, newFlow, loginHint);
        if (preferPopup) {
            this.popup =
                popup.open(this.window, url, 'Schibsted account', { width: 360, height: 570 });
            if (this.popup) {
                return this.popup;
            }
        }
        this.window.location.href = url;
        return null;
    }

    /**
     * @summary Logs the user out from the Identity platform
     * @description **Note**: Your site origin should be listed as a redirect_uri in selfservice for
     * this to work. On the Schibsted account side, we check CORS headers against the list of
     * redirect_uris. For most sites, this will work already, since this matching is only done on
     * the origin part of the uri, and most sites already have that in their redirect_uri list. So
     * if you have a redirect_uri `https://mysite.news/article`, then this will work when coming
     * from any `https://mysite.news` location. Note however, that the protocol matters, so it will
     * not work for `http://mysite.news` (only `https`).
     * @return {void}
     */
    async logout() {
        // At the moment we have two endpoints that can have user session: SPiD and BFF
        // if one of them returns success, we assume that the login was successful
        // but if both fail, then we haven't really logged the user out.
        /**
         * A little utility function that returns a boolean based on if a promise has failed or
         * succeeded.
         * @param {Promise} p
         * @return {Promise}
         */
        const booleanize = p => p.then(() => true, () => false);
        const [spidLoggedOut, bffLoggedOut] = await Promise.all([
            booleanize(this._spid.get('ajax/logout.js')),
            booleanize(this._bffService.get('api/identity/logout')),
        ]);
        if (spidLoggedOut || bffLoggedOut) {
            this.cache.delete(HAS_SESSION_CACHE_KEY);
            this.emit('logout');
        } else {
            const err = new SDKError('Could not log out from any endpoint');
            this.emit('error', err);
            throw err;
        }
    }

    /**
     * Generates the link to the new login page that'll be used in the popup or redirect flow
     * @param {string} state - An opaque value used by the client to maintain state between the
     * request and callback. It's also recommended to prevent CSRF.
     * @see https://tools.ietf.org/html/rfc6749#section-10.12
     * @param {string} [acrValues] - Authentication method. If omitted, user authenticates with
     * username+password. If set to `'otp-email'`, then  passwordless login using email is used. If
     * `'otp-sms'`, then passwordless login using sms is used. Please note that this parameter has
     * no effect if `newFlow` is false
     * @param {string} [scope='openid']
     * @param {string} [redirectUri=this.redirectUri]
     * @param {boolean} [newFlow=true] - Should we try the new flow or the old Schibsted account
     * login? If this parameter is set to false, the `acrValues` parameter doesn't have any effect
     * @param {string} [loginHint=''] - user email hint
     * @return {string} - The url
     */
    loginUrl(
        state,
        acrValues,
        scope = 'openid',
        redirectUri = this.redirectUri,
        newFlow = true,
        loginHint = ''
    ) {
        assert(!acrValues || isStrIn(acrValues, ['', 'otp-email', 'otp-sms'], true),
            `The acrValues parameter is not acceptable: ${acrValues}`);
        assert(isUrl(redirectUri),
            `loginUrl(): redirectUri must be a valid url but is ${redirectUri}`);
        assert(isNonEmptyString(state),
            `the state parameter should be a non empty string but it is ${state}`);


        if (newFlow) {
            return this._oauthService.makeUrl('oauth/authorize', {
                response_type: 'code',
                'new-flow': true,
                redirect_uri: redirectUri,
                scope,
                state,
                acr_values: acrValues,
                login_hint: loginHint
            });
        } else {
            // acrValues do not work with the old flows
            return this._spid.makeUrl('flow/login', {
                response_type: 'code',
                redirect_uri: redirectUri,
                scope,
                state,
                email: loginHint
            });
        }
    }

    /**
     * The url for logging the user out
     * @param {string} [redirectUri=this.redirectUri]
     * @return {string} url
     */
    logoutUrl(redirectUri = this.redirectUri) {
        assert(isUrl(redirectUri), `logoutUrl(): redirectUri is invalid`);
        return this._spid.makeUrl('logout', {
            response_type: 'code',
            redirect_uri: redirectUri
        });
    }


    /**
     * The account summary page url
     * @param {string} [redirectUri=this.redirectUri]
     * @return {string}
     */
    accountUrl(redirectUri = this.redirectUri) {
        return this._spid.makeUrl('account/summary', {
            response_type: 'code',
            redirect_uri: redirectUri
        });
    }

    /**
     * The phone editing page url
     * @param {string} [redirectUri=this.redirectUri]
     * @return {string}
     */
    phonesUrl(redirectUri = this.redirectUri) {
        return this._spid.makeUrl('account/phones', {
            response_type: 'code',
            redirect_uri: redirectUri
        });
    }

    /**
     * Url to render either signup or login
     * @see https://techdocs.spid.no/flows/auth-flow/
     * @param {string} [redirectUri=this.redirectUri]
     * @return {string} - the url to the authentication page
     */
    authFlowUrl(redirectUri = this.redirectUri) {
        assert(isUrl(redirectUri), `authFlowUrl(): redirectUri is invalid`);
        return this._spid.makeUrl('flow/auth', {
            response_type: 'code',
            redirect_uri: redirectUri
        });
    }

    /**
     * Url to render a signup view and let the user login with credentials
     * @see https://techdocs.spid.no/flows/auth-flow/
     * @param {string} [redirectUri=this.redirectUri]
     * @return {string} - the url to the signup page
     */
    signupFlowUrl(redirectUri = this.redirectUri) {
        assert(isUrl(redirectUri), `signupFlowUrl(): redirectUri is invalid`);
        return this._spid.makeUrl('flow/signup', {
            response_type: 'code',
            redirect_uri: redirectUri
        });
    }

    /**
     * To render a signin view and let the user login without credentials
     * @see https://techdocs.spid.no/flows/auth-flow/
     * @param {string} [redirectUri=this.redirectUri]
     * @return {string} - the url to the signin page
     */
    signinFlowUrl(redirectUri = this.redirectUri) {
        assert(isUrl(redirectUri), `signinFlowUrl(): redirectUri is invalid`);
        return this._spid.makeUrl('flow/signin', {
            response_type: 'code',
            redirect_uri: redirectUri
        });
    }
}

export default Identity;