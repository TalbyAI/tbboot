# Sources declare dependencies and discover first-level Recipes

For the MVP, `source.yaml` may declare Source dependencies but does not contain an identity field, duplicate provider selection metadata, or enumerate Recipes. Source identity is derived from the provider and locator. Recipes are discovered only in first-level Source directories containing `recipe.yaml`, and their identity is derived from the relative folder path; there is no implicit recursive discovery.
