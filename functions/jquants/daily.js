/**
 * J-Quants API proxy.
 *
 * Browsers cannot reliably call the J-Quants API directly because its CORS
 * policy can reject cross-origin requests. The token may be supplied per
 * request or stored in the JQUANTS_TOKEN Pages secret / local .dev.vars file.
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

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  const code = (url.searchParams.get('code') || '').trim()
  const date = (url.searchParams.get('date') || '').replace(/-/g, '')
  const authorization = request.headers.get('Authorization') || ''
  const requestToken = authorization.replace(/^Bearer\s+/i, '').trim()
  const token = requestToken || env.JQUANTS_TOKEN || ''

  if (!/^\d{5}$/.test(code))
    return json({ error: '銘柄コードは5桁で指定してください。' }, 400)
  if (!/^\d{8}$/.test(date))
    return json({ error: '日付はYYYY-MM-DDで指定してください。' }, 400)
  if (!token)
    return json(
      {
        error:
          'J-Quants IDトークンがありません。.dev.vars または Pages Secret に JQUANTS_TOKEN を設定してください。',
      },
      400,
    )

  try {
    const apiUrl = new URL('https://api.jquants.com/v2/equities/bars/daily')
    apiUrl.searchParams.set('code', code)
    apiUrl.searchParams.set('from', date)
    apiUrl.searchParams.set('to', date)

    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
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

    // API v2 returns `data`; accept the former key too for forward compatibility.
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
