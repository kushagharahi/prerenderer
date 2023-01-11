import Prerenderer, { IRenderer, RenderedRoute } from '@prerenderer/prerenderer'

import promiseLimit from 'promise-limit'
import puppeteer, { Browser, Page } from 'puppeteer'
import { PuppeteerRendererFinalOptions, PuppeteerRendererOptions, schema, defaultOptions } from './Options'
import { waitForRender, listenForRender } from './waitForRender'
import { validate } from 'schema-utils'
import { Schema } from 'schema-utils/declarations/validate'
import deepMerge from 'ts-deepmerge'

export default class PuppeteerRenderer implements IRenderer {
  private puppeteer: Browser
  private readonly options: PuppeteerRendererFinalOptions

  constructor (options: PuppeteerRendererOptions) {
    validate(schema as Schema, options, {
      name: 'Renderer Puppeteer',
      baseDataPath: 'options',
    })
    this.options = deepMerge(defaultOptions, options) as PuppeteerRendererFinalOptions
  }

  async initialize () {
    try {
      // Workaround for Linux SUID Sandbox issues.
      if (process.platform === 'linux') {
        if (!this.options.args) this.options.args = []

        if (this.options.args.indexOf('--no-sandbox') === -1) {
          this.options.args.push('--no-sandbox')
          this.options.args.push('--disable-setuid-sandbox')
        }
      }

      // Is it a good idea to pass the whole option list there?
      this.puppeteer = await puppeteer.launch(this.options)
    } catch (e) {
      console.error(e)
      console.error('[Prerenderer - PuppeteerRenderer] Unable to start Puppeteer')
      // Re-throw the error so it can be handled further up the chain. Good idea or not?
      throw e
    }
  }

  async handleRequestInterception (page: Page, baseURL: string) {
    await page.setRequestInterception(true)

    page.on('request', (req) => {
      // Skip third party requests if needed.
      if (this.options.skipThirdPartyRequests) {
        if (!req.url().startsWith(baseURL)) {
          void req.abort()
          return
        }
      }

      void req.continue()
    })
  }

  async renderRoutes (routes: Array<string>, prerenderer: Prerenderer) {
    const rootOptions = prerenderer.getOptions()
    const options = this.options

    const limiter = promiseLimit<RenderedRoute>(this.options.maxConcurrentRoutes)

    return Promise.all(
      routes.map(
        (route) => limiter(
          async () => {
            const page = await this.puppeteer.newPage()

            if (options.consoleHandler) {
              const handler = options.consoleHandler
              page.on('console', message => handler(route, message))
            }

            if (options.inject) {
              await page.evaluateOnNewDocument(`(function () { window['${options.injectProperty}'] = ${JSON.stringify(options.inject)}; })();`)
            }

            const baseURL = `http://${rootOptions.server.host}:${rootOptions.server.port}`

            // Allow setting viewport widths and such.
            if (options.viewport) await page.setViewport(options.viewport)

            await this.handleRequestInterception(page, baseURL)

            // Expire after 2 minutes by default
            const timeoutAfter = options.timeout
            let timeout: NodeJS.Timeout | null = null
            if (timeoutAfter && !options.renderAfterTime) {
              timeout = setTimeout(() => {
                if (options.renderAfterDocumentEvent) {
                  throw new Error(
                    `Could not prerender: event '${options.renderAfterDocumentEvent}' did not occur within ${Math.round(timeoutAfter / 1000)}s`)
                }
                if (options.renderAfterElementExists) {
                  throw new Error(
                    `Could not prerender: element '${options.renderAfterElementExists}' did not appear within ${Math.round(timeoutAfter / 1000)}s`)
                }
                throw new Error(
                    `Could not prerender: timed-out after ${Math.round(timeoutAfter / 1000)}s`)
              }, timeoutAfter)
            }

            // Hack just in-case the document event fires before our main listener is added.
            if (options.renderAfterDocumentEvent) {
              await page.evaluateOnNewDocument(listenForRender, options)
            }

            const navigationOptions = { waituntil: 'networkidle0', timeout: options.timeout, ...options.navigationOptions }
            await page.goto(`${baseURL}${route}`, navigationOptions)

            // Wait for some specific element exists
            if (this.options.renderAfterElementExists) {
              await page.waitForSelector(this.options.renderAfterElementExists)
            }

            // Once this completes, it's safe to capture the page contents.
            await page.evaluate(waitForRender, this.options)

            if (timeout) {
              clearTimeout(timeout)
            }

            const result: RenderedRoute = {
              originalRoute: route,
              route: await page.evaluate('window.location.pathname') as string,
              html: await page.content(),
            }

            await page.close()
            return result
          },
        ),
      ),
    )
  }

  async destroy () {
    if (this.puppeteer) {
      try {
        await this.puppeteer.close()
      } catch (e) {
        console.error(e)
        console.error('[Prerenderer - PuppeteerRenderer] Unable to close Puppeteer')

        throw e
      }
    }
  }
}
