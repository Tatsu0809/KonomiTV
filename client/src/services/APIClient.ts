
/**
 * services/ 直下の各クラスは、KonomiTV サーバーへの API リクエストを抽象化し、
 * API レスポンスの受け取りと、エラーが発生した際のエラーハンドリング (エラーメッセージ表示) までを責務として負う
 */

import axios, { AxiosError, AxiosRequestConfig, AxiosResponse, AxiosResponseHeaders, RawAxiosResponseHeaders } from 'axios';

import Message from '@/message';
import useCFZTStore from '@/stores/CloudflareZerotrustStone';
import useUserStore from '@/stores/UserStore';
import Utils from '@/utils';


// プロキシ認証への画面遷移を、同時に失敗した複数の API から重複して始めない
let proxy_auth_redirect_started = false;


/**
 * Apache (mod_auth_openidc) が fetch / XHR に返す 401 かどうかを判定する
 * 画面遷移には IdP への 302 を返すが、Sec-Fetch-Mode: cors の API リクエストには HTML の 401 を返す
 * KonomiTV 自身の 401 は JSON の detail なので、ここには含めない
 * @param data Axios が受け取ったレスポンスボディ
 * @returns Apache の認証エラーなら true
 */
function IsApacheOIDCUnauthorized(data: unknown): boolean {
    return typeof data === 'string' && data.includes('<h1>Unauthorized</h1>');
}


/**
 * Service Worker を外してから、同じ URL へ画面遷移する
 * 画面遷移は Sec-Fetch-Mode: navigate になるため、Apache が IdP へ 302 する
 */
export async function RedirectForApacheOIDC(): Promise<void> {
    if (proxy_auth_redirect_started) {
        return;
    }
    const current_url = new URL(location.href);
    if (current_url.searchParams.get('pwa') === 'false' || current_url.searchParams.get('__cf_access_message')) {
        return;
    }
    proxy_auth_redirect_started = true;
    console.log('Apache OIDC login need!!');
    current_url.searchParams.set('pwa', 'false');
    if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    location.href = current_url.href;
}


/** API リクエスト成功時のレスポンスを表すインターフェイス */
export interface ISuccessResponse<T> {
    type: 'success';
    status: number;
    headers: RawAxiosResponseHeaders | AxiosResponseHeaders;
    data: T;
}

/** API リクエスト失敗時のレスポンスを表すインターフェイス */
export interface IErrorResponse {
    type: 'error';
    status: number;
    headers: RawAxiosResponseHeaders | AxiosResponseHeaders;
    data: IErrorResponseData;
    error: AxiosError<IErrorResponseData>;
}

/**
 * API リクエスト失敗時にサーバーから返されるエラーレスポンスを表すインターフェイス
 * HTTP リクエスト自体が失敗した場合は、detail に AxiosError のエラーメッセージが入る
 */
export interface IErrorResponseData {
    detail: string | [{
        type: string;
        loc: (string | number)[];
        msg: string;
        input?: any;
        url?: string;
    }]
}


/**
 * services/ 以下の各クラスから呼び出される、Axios の薄いラッパー
 * エラーハンドリングを容易にするために、レスポンスを ISuccessResponse と IErrorResponse に分けて返す
 * ref: https://zenn.dev/engineer_titan/articles/291c9fccb338e2
 */
class APIClient {

    /**
     * Axios で HTTP リクエストを送信し、レスポンスを受け取る
     * @param request AxiosRequestConfig
     * @returns 成功なら ISuccessResponse 、失敗なら IErrorResponse を返す
     */
    static async request<T>(request: AxiosRequestConfig): Promise<ISuccessResponse<T> | IErrorResponse> {

        // API のベース URL を設定 (config.baseURL が指定されていない場合のみ)
        if (request.baseURL === undefined) {
            request.baseURL = Utils.api_base_url;
        }

        // リクエストヘッダーが指定されていない場合は空のオブジェクトを設定
        if (request.headers === undefined) {
            request.headers = {};
        }

        // 外部サイトへの HTTP/HTTPS リクエストでは実行しない
        if (request.url?.startsWith('http') === false) {

            // アクセストークンが取得できたら (=ログインされていれば)
            // 取得したアクセストークンを Authorization ヘッダーに Bearer トークンとしてセット
            // これを忘れると当然ながらログインしていない扱いになる
            const access_token = Utils.getAccessToken();
            if (access_token !== null) {
                request.headers['Authorization'] = `Bearer ${access_token}`;
            }

            // KonomiTV クライアントのバージョンを設定
            // 今のところ使わないが、将来的にクライアントとサーバーを分離することを見据えて念のため
            request.headers['X-KonomiTV-Version'] = Utils.version;
        }

        // リクエストのタイムアウト時間を30秒に設定
        // 既にタイムアウト時間が設定されている場合は上書きしない
        if (request.timeout === undefined) {
            request.timeout = 30 * 1000;
        }

        // リクエストのタイムアウト時に、一般的な ECONNABORTED の代わりに ETIMEDOUT を送出する
        request.transitional = {
            clarifyTimeoutError: true,
        };

        // Axios で HTTP リクエストを送信し、レスポンスを受け取る
        const result: AxiosResponse<T> | AxiosError<IErrorResponseData> = await axios.request(request).catch((error) => error);

        // エラーが発生した場合は IErrorResponse を返す
        if (result instanceof AxiosError) {
            console.error(result);

            // エラーレスポンスがあれば、エラー内容と AxiosError を IErrorResponse に入れて返す
            if (result.response) {
                // fetch 相当の API リクエストには、未ログインの Apache が HTML の 401 を返す
                // この 401 を画面遷移に変えると、ブラウザが IdP への 302 を受け取れる
                if (result.response.status === 401 && IsApacheOIDCUnauthorized(result.response.data)) {
                    void RedirectForApacheOIDC();
                }
                return {
                    type: 'error',
                    status: result.response.status,
                    headers: result.response.headers,
                    data: result.response.data,  // data には IErrorResponseData が入る
                    error: result,  // AxiosError をそのまま入れる
                };

            // エラーレスポンスがない場合は、AxiosError のみを IErrorResponse に入れて返す
            } else {
                return {
                    type: 'error',
                    status: NaN,  // ステータスコードは取得できないので NaN にする
                    headers: {},  // ヘッダーも取得できないので空のオブジェクトにする
                    data: {detail: result.message},  // data.detail に AxiosError のエラーメッセージを入れる
                    error: result,  // AxiosError をそのまま入れる
                };
            }

        // 正常にレスポンスが返ってきた場合は ISuccessResponse を返す
        } else {
            return {
                type: 'success',
                headers: result.headers,
                status: result.status,
                data: result.data,
            };
        }
    }


    /**
     * GET リクエストを送信する
     * @param url リクエスト先の URL
     * @param config AxiosRequestConfig
     * @returns 成功なら ISuccessResponse 、失敗なら IErrorResponse を返す
     */
    static async get<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<ISuccessResponse<T> | IErrorResponse> {
        const request: AxiosRequestConfig = {
            url: url,
            method: 'GET',
            ...config,
        };
        return await APIClient.request<T>(request);
    }


    /**
     * POST リクエストを送信する
     * @param url リクエスト先の URL
     * @param data 送信するデータ
     * @param config AxiosRequestConfig
     * @returns 成功なら ISuccessResponse 、失敗なら IErrorResponse を返す
     */
    static async post<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<ISuccessResponse<T> | IErrorResponse> {
        const request: AxiosRequestConfig = {
            url: url,
            method: 'POST',
            data: data,
            ...config,
        };
        return await APIClient.request<T>(request);
    }


    /**
     * PUT リクエストを送信する
     * @param url リクエスト先の URL
     * @param data 送信するデータ
     * @param config AxiosRequestConfig
     * @returns 成功なら ISuccessResponse 、失敗なら IErrorResponse を返す
     */
    static async put<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<ISuccessResponse<T> | IErrorResponse> {
        const request: AxiosRequestConfig = {
            url: url,
            method: 'PUT',
            data: data,
            ...config,
        };
        return await APIClient.request<T>(request);
    }


    /**
     * DELETE リクエストを送信する
     * @param url リクエスト先の URL
     * @param config AxiosRequestConfig
     * @returns 成功なら ISuccessResponse 、失敗なら IErrorResponse を返す
     */
    static async delete<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<ISuccessResponse<T> | IErrorResponse> {
        const request: AxiosRequestConfig = {
            url: url,
            method: 'DELETE',
            ...config,
        };
        return await APIClient.request<T>(request);
    }


    /**
     * 一般的なエラーメッセージの共通処理
     * エラーメッセージを SnackBar で表示する
     * @param error_response API から返されたエラーレスポンス
     * @param template エラーメッセージのテンプレート（「アカウント情報を取得できませんでした。」など)
     */
    static showGenericError(error_response: IErrorResponse, template: string): void {

        // ブラウザが明確にオフラインと判定した通信失敗では、サーバーが応答したエラーだけを利用者通知の対象にする
        // navigator.onLine が true でもサーバーへ到達できる保証はないため、オンライン扱いのエラーは従来どおり表示する
        if (Number.isNaN(error_response.status) && navigator.onLine === false) {
            return;
        }
        const user_store = useUserStore();
        switch (error_response.data.detail) {
            case 'Not authenticated': {
                user_store.logout(true);
                Message.error(`${template}\nログインし直してください。`);
                return;
            }
            case 'Access token data is invalid': {
                user_store.logout(true);
                Message.error(`${template}\nログインセッションが不正です。もう一度ログインし直してください。`);
                return;
            }
            case 'Access token is invalid': {
                user_store.logout(true);
                Message.error(`${template}\nログインセッションの有効期限が切れています。もう一度ログインし直してください。`);
                return;
            }
            case 'User associated with access token does not exist': {
                user_store.logout(true);
                Message.error(`${template}\nログインセッションに紐づくユーザーが存在しないか、削除されています。`);
                return;
            }
            case 'Don\'t have permission to access this resource': {
                Message.error(`${template}\nこのリソースにアクセスする権限がありません。`);
                return;
            }
            default: {
                if (Array.isArray(error_response.data.detail)) {
                    // バリデーションエラーが発生した場合
                    // error_response.data.detail が配列の場合は、バリデーションエラーが発生したとみなす
                    // FastAPI が返すバリデーションエラーのレスポンスを整形して、エラーメッセージを表示する
                    let message = '';
                    for (const error of error_response.data.detail) {
                        // いい感じに loc を整形して、コードっぽくする
                        const loc = error.loc.map(item => typeof item === 'number' ? `[${item}]` : item).join('.')
                            .replaceAll('.[', '[').replaceAll('body.', '').replaceAll('query.', '');
                        message += `⚠️ ${loc}: ${error.msg.replace('Value error, ', '')}\n`;
                    }
                    Message.error(`${template}\n${message}`);
                    return;
                } else if (Number.isNaN(error_response.status)) {
                    // HTTP リクエスト自体が失敗し、HTTP ステータスコードが取得できなかった場合
                    if (error_response.error.code === AxiosError.ECONNABORTED) {
                        // ネットワーク接続エラーの場合
                        Message.error(`${template}\nサーバーへの接続が切断されました。(${error_response.error.message})`);
                    } else if (error_response.error.code === AxiosError.ETIMEDOUT) {
                        // タイムアウトの場合
                        Message.error(`${template}\nサーバーへの接続がタイムアウトしました。(${error_response.error.message})`);
                    } else if (error_response.error.code === AxiosError.ERR_NETWORK) {
                        // 予期しないネットワークエラーの場合
                        // Cloudflare の身元確認や、プロキシ認証への遷移を始めるリクエスト自身は、ここから再度遷移しない
                        if (error_response.error.config?.url?.startsWith('/cdn-cgi/') || proxy_auth_redirect_started) {
                            Message.error(`${template}\n予期しないネットワークエラーが発生しました。(${error_response.error.message})`);
                            return;
                        }
                        // 同時に失敗した API から、認証の確認と画面遷移を二重に始めない
                        proxy_auth_redirect_started = true;
                        (async ()=>{
                            const u = new URL(location.href);
                            // 認証用の画面遷移を終えた直後か、Cloudflare Access のエラー画面では通常のエラー表示に戻す
                            if (u.searchParams.get('pwa') === 'false' || u.searchParams.get('__cf_access_message')) {
                                proxy_auth_redirect_started = false;
                                Message.error(`${template}\n予期しないネットワークエラーが発生しました。(${error_response.error.message})`);
                                return;
                            }

                            // Apache (mod_auth_openidc) は未ログインの API を IdP へ 302 する
                            // axios は別オリジンへのリダイレクトをネットワークエラーとして返すため、
                            // 実際の API と同じ URL を、リダイレクトを追わずに一度だけ見る
                            // 302 は opaqueredirect、OIDCUnAuthAction 401 のときは 401 になる
                            let oidc_response: Response | null = null;
                            try {
                                oidc_response = await fetch(`${Utils.api_base_url}/version`, {
                                    redirect: 'manual',
                                    credentials: 'include',
                                    cache: 'no-store',
                                });
                            } catch (error) {
                                // サーバーに届かなかった場合は、下の通常エラーとして表示する
                                console.error(error);
                            }
                            let needs_oidc_login = oidc_response !== null && oidc_response.type === 'opaqueredirect';
                            if (oidc_response !== null && oidc_response.status === 401) {
                                // fetch には 302 ではなく HTML の 401 が返る
                                needs_oidc_login = (await oidc_response.text()).includes('<h1>Unauthorized</h1>');
                            }

                            const CFZTStore = useCFZTStore();
                            if (needs_oidc_login === false) {
                                await CFZTStore.fetchCFZTIdentity();
                            }
                            if (needs_oidc_login) {
                                proxy_auth_redirect_started = false;
                                await RedirectForApacheOIDC();
                                return;
                            }
                            if (CFZTStore.is_CFZT && !CFZTStore.is_login) {
                                console.log('Cloudflare ZeroTrust Login need!!');
                                u.searchParams.set('pwa', 'false');
                                if ('serviceWorker' in navigator) {
                                    const registrations = await navigator.serviceWorker.getRegistrations();
                                    await Promise.all(registrations.map((registration) => registration.unregister()));
                                }
                                location.href = u.href;
                                return;
                            }

                            // プロキシ認証が原因ではなかったので、次のネットワークエラーで確認し直す
                            proxy_auth_redirect_started = false;
                            Message.error(`${template}\n予期しないネットワークエラーが発生しました。(${error_response.error.message})`);
                        })();
                    } else {
                        // それ以外のエラーの場合
                        Message.error(`${template}(${error_response.error.message})`);
                    }
                } else {
                    // HTTP リクエスト自体は成功したが、API からエラーレスポンスが返ってきた場合
                    if (error_response.status === 502) {
                        Message.error(`${template}\n現在サーバーを起動/再起動しています。もうしばらくお待ちください。(HTTP Error 502)`);
                    } else if (error_response.data.detail !== undefined) {
                        Message.error(`${template}(HTTP Error ${error_response.status} / ${error_response.data.detail})`);
                    } else {
                        Message.error(`${template}(HTTP Error ${error_response.status} / ${error_response.error.message})`);
                    }
                }
                return;
            }
        }
    }
}

export default APIClient;
