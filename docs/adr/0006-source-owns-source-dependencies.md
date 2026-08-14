# Sources own Source dependencies

Dependencies belong to the Source definition; catalogs may index that information but are not required for direct installation. A Source dependency may expose selected Recipes through a local alias so Recipes in the dependent Source can use them. When no Recipe selection is declared, the MVP continues to install the complete dependent Source; explicit selection and Recipe dependencies remain reserved for the future contract.
