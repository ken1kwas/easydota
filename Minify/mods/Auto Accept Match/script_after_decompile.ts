import fs from "node:fs";
import path from "node:path";

import { base, log, xmlUtils } from "@minify/sdk";

const MINIFY_SECTION_XML = `
<Panel class="SettingsSectionContainer" section="#minify" icon="s2r://panorama/images/control_icons/24px/check.vsvg">
  <Panel class="SettingsSectionTitleContainer LeftRightFlow">
    <Image class="SettingsSectionTitleIcon" texturewidth="48px" textureheight="48px" scaling="stretch-to-fit-preserve-aspect" src="s2r://panorama/images/control_icons/24px/check.vsvg" />
    <Label class="SettingsSectionTitle" text="Minify" />
  </Panel>
</Panel>
`;

export function main(): void {
  const menuXmlPath = path.join(__dirname, "menu.xml");
  if (!fs.existsSync(menuXmlPath)) return;

  const menuData = fs.readFileSync(menuXmlPath, "utf8");
  if (!menuData.trim().startsWith("<Panel ")) {
    log.writeWarning(`Improper mod menu on ${path.basename(__dirname)}!`);
    return;
  }

  const settingsPath = path.join(base.buildDir, "panorama", "layout", "popups", "popup_settings_reborn.xml");
  if (!fs.existsSync(settingsPath)) {
    log.writeWarning(`Settings file not found at ${settingsPath}`);
    return;
  }

  try {
    const doc = xmlUtils.parseXml(fs.readFileSync(settingsPath, "utf8"));
    const settingsBody = xmlUtils.findDescendant(doc.documentElement, "PopupSettingsRebornSettingsBody");
    if (!settingsBody) return;

    const section = xmlUtils.fromString(doc, MINIFY_SECTION_XML);
    settingsBody.appendChild(section);
    section.appendChild(xmlUtils.fromString(doc, menuData));
    fs.writeFileSync(settingsPath, xmlUtils.serialize(doc.documentElement), "utf8");
  } catch (err) {
    if (err instanceof xmlUtils.XmlParseError) log.writeWarning(`Failed to parse ${settingsPath} or menu.xml: ${err.message}`);
    else log.writeWarning(`Error applying menu mod: ${err}`);
  }
}
