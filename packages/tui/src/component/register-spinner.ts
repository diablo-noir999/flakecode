import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerFlakecodeSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
