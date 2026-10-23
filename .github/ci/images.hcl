# Both production images, built concurrently by one buildx bake in CI.
# Contexts resolve from the repo root, where the bake runs.

# Set to any value on trusted main pushes to publish the shared layer cache.
variable "PUBLISH_CACHE" {
  default = ""
}

group "default" {
  targets = ["stripe-bridge", "fleet-monitor"]
}

# The same server.Dockerfile args docker-compose.yml passes.
target "image" {
  name = item.app
  matrix = {
    item = [
      {
        app             = "stripe-bridge"
        port            = "8000"
        db_env          = "MAP_DB_PATH"
        db_file         = "bridge.db"
        system_packages = ""
      },
      {
        app             = "fleet-monitor"
        port            = "8010"
        db_env          = "FM_DB_PATH"
        db_file         = "fleet.db"
        system_packages = "openssh-client"
      },
    ]
  }
  context    = "."
  dockerfile = "server.Dockerfile"
  args = {
    APP             = item.app
    PORT            = item.port
    DB_ENV          = item.db_env
    DB_FILE         = item.db_file
    SYSTEM_PACKAGES = item.system_packages
  }
  tags       = ["${item.app}:sanity"]
  output     = ["type=docker"]
  cache-from = ["type=gha,scope=${item.app}"]
  cache-to   = notequal("", PUBLISH_CACHE) ? ["type=gha,scope=${item.app},mode=max"] : []
}
