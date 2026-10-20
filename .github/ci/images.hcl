# Both production images, built concurrently by one buildx bake in CI.
# Contexts resolve from the repo root, where the bake runs.

# Set to any value on trusted main pushes to publish the shared layer cache.
variable "PUBLISH_CACHE" {
  default = ""
}

group "default" {
  targets = ["stripe-bridge", "fleet-monitor"]
}

target "image" {
  name       = app
  matrix     = { app = ["stripe-bridge", "fleet-monitor"] }
  context    = "."
  dockerfile = "apps/${app}/Dockerfile"
  tags       = ["${app}:sanity"]
  output     = ["type=docker"]
  cache-from = ["type=gha,scope=${app}"]
  cache-to   = notequal("", PUBLISH_CACHE) ? ["type=gha,scope=${app},mode=max"] : []
}
