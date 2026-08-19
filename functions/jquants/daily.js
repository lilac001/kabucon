/**
 * J-Quants API proxy.
 *
 * Browsers cannot reliably call the J-Quants API directly because its CORS
 * policy can reject cross-origin requests.
 *
 * 認証方式:
 *   J-Quants API v2 (2025-12-22以降登録) → API キー認証
 *   旧 v1 ID トークン方式も後方互換として受け付ける
 *
 * 環境変数 (.dev.vars / Pages Secret どちらにも設定可):
 *   JQUANTS_API_KEY  ... v2 API キー → x-api-key ヘッダーで送信 (推奨)
 *   JQUANTS_TOKEN    ... v1 ID トークン → Authorization: Bearer で送信 (後方互換)
 *
 * 環境変数が設定済みであれば画面入力は不要。
 */
'use strict'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })

/**
 * 使用する Authorization ヘッダー値を決定する。
 * 優先順位: 環境変数 JQUANTS_API_KEY > リクエストヘッダー > 環境変数 JQUANTS_TOKEN
 */
/**
 * 認証情報を { type, value } で返す。
 *   type='apikey'  → x-api-key ヘッダー (v2)
 *   type='bearer'  → Authorization: Bearer ヘッダー (v1 後方互換)
 * 優先順位: 環境変数 JQUANTS_API_KEY > リクエストの x-api-key/Authorization > 環境変数 JQUANTS_TOKEN
 */
function resolveAuth(request, env) {
  const envApiKey = (env.JQUANTS_API_KEY || '').trim()
  if (envApiKey) return { type: 'apikey', value: envApiKey }

  const reqApiKey = (request.headers.get('x-api-key') || '').trim()
  if (reqApiKey) return { type: 'apikey', value: reqApiKey }

  const bearer = (request.headers.get('Authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  if (bearer) return { type: 'bearer', value: bearer }

  const envToken = (env.JQUANTS_TOKEN || '').trim()
  if (envToken) return { type: 'bearer', value: envToken }

  return null
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  const code = (url.searchParams.get('code') || '').trim()
  const date = (url.searchParams.get('date') || '').replace(/-/g, '')
  if (!/^\d{5}$/.test(code))
    return json({ error: '銘柄コードは5桁で指定してください。' }, 400)
  if (!/^\d{8}$/.test(date))
    return json({ error: '日付はYYYY-MM-DDで指定してください。' }, 400)

  const auth = resolveAuth(request, env)
  if (!auth)
    return json(
      {
        error:
          'J-Quants の認証情報がありません。' +
          '.dev.vars または Pages Secret に JQUANTS_API_KEY を設定してください。',
      },
      400,
    )

  try {
    const apiUrl = new URL('https://api.jquants.com/v2/equities/bars/daily')
    apiUrl.searchParams.set('code', code)
    apiUrl.searchParams.set('from', date)
    apiUrl.searchParams.set('to', date)

    const apiHeaders = { Accept: 'application/json' }
    if (auth.type === 'apikey') {
      apiHeaders['x-api-key'] = auth.value
    } else {
      apiHeaders['Authorization'] = `Bearer ${auth.value}`
    }

    const response = await fetch(apiUrl, { headers: apiHeaders })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      return json(
        {
          error:
            body.message ||
            body.error ||
            `J-Quants API エラー (HTTP ${response.status})`,
        },
        response.status,
      )
    }

    // v2 は `data` キー、旧 v1 互換として `daily_quotes` も受け付ける
    const quote = (body.data || body.daily_quotes || [])[0]
    if (!quote)
      return json(
        {
          error:
            '指定日の株価データがありません。休場日・銘柄コードを確認してください。',
        },
        404,
      )
    return json({ quote })
  } catch (_) {
    return json(
      {
        error:
          'J-Quants APIへ接続できませんでした。しばらくしてから再試行してください。',
      },
      502,
    )
  }
}
