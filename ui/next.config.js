const bundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true"
})
const FilterWarningsPlugin = require("webpack-filter-warnings-plugin")
const optimizedImages = require("next-optimized-images")
const sass = require("@zeit/next-sass")

const withPlugins = require("next-compose-plugins")

const isProd = process.env.NODE_ENV === "production"

// Base path of the application
// Magic string will be replaced by Steep's HttpEndpoint verticle
const basePath = isProd ? "/$$MYBASEPATH$$" : ""

const config = {
  env: {
    // URL to Steep. Used to connect to the event bus.
    // Magic string will be replaced by Steep's HttpEndpoint verticle
    baseUrl: isProd ? "/$$MYBASEURL$$" : "http://localhost:8080",

    // Base path of the web application (see above)
    basePath
  },

  // create a folder for each page
  exportTrailingSlash: true,

  // do not display static optimization indicator
  // it gets in the way of notifications
  devIndicators: {
    autoPrerender: false
  },

  experimental: {
    basePath
  },

  // list pages to export
  exportPathMap() {
    return {
      "/": { page: "/" },
      "/agents": { page: "/agents" },
      "/agents/[id].html": { page: "/agents/[id]" },
      "/processchains": { page: "/processchains" },
      "/processchains/[id].html": { page: "/processchains/[id]" },
      "/services": { page: "/services" },
      "/services/[id].html": { page: "/services/[id]" },
      "/vms": { page: "/vms" },
      "/vms/[id].html": { page: "/vms/[id]" },
      "/workflows": { page: "/workflows" },
      "/workflows/[id].html": { page: "/workflows/[id]" }
    }
  },

  webpack: (config, { dev }) => {
    if (dev) {
      config.module.rules.push({
        test: /\.jsx?$/,
        loader: "eslint-loader",
        exclude: [/node_modules/, /\.next/, /out/],
        enforce: "pre",
        options: {
          emitWarning: true
        }
      })
    }

    // We can ignore the order to CSS files because we use very strict scoping.
    // There should never be any conflicts in our CSS files.
    config.plugins.push(
      new FilterWarningsPlugin({
        exclude: /mini-css-extract-plugin[^]*Conflicting order between:/
      })
    )

    return config
  }
}

module.exports = withPlugins([
  [optimizedImages],
  [sass],
  [bundleAnalyzer]
], config)
