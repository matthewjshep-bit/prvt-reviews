import test from "node:test";
import assert from "node:assert/strict";
import { parseGhlUrl } from "./ghl-url.js";

const LOC = "AbCdEf123456GhIjKl78";
const CONTACT = "Zx9Yw8Vu7Ts6Rq5Po4Nm";
const CONVO = "Qw1Er2Ty3Ui4Op5As6Df";

test("a GHL contact page names that contact", () => {
  assert.deepEqual(parseGhlUrl(`https://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${CONTACT}`),
    { locationId: LOC, contactId: CONTACT, conversationId: null });
});

test("a GHL conversation page names the conversation, for the broker to turn into a contact", () => {
  assert.deepEqual(parseGhlUrl(`https://app.gohighlevel.com/v2/location/${LOC}/conversations/conversations/${CONVO}`),
    { locationId: LOC, contactId: null, conversationId: CONVO });
});

test("a query, a hash or a trailing slash on the address is still the same person", () => {
  for (const tail of ["/", "?view=notes", "#tasks", "/?tab=activity#x"]) {
    assert.equal(parseGhlUrl(`https://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${CONTACT}${tail}`)?.contactId, CONTACT, tail);
  }
});

test("GHL's white-label host works the same", () => {
  assert.equal(parseGhlUrl(`https://app.leadconnectorhq.com/v2/location/${LOC}/contacts/detail/${CONTACT}`)?.contactId, CONTACT);
});

test("the contact list, the inbox, settings and our own menu-link pages are no one", () => {
  for (const path of [
    `/v2/location/${LOC}/contacts/smart_list/All`,
    `/v2/location/${LOC}/contacts/detail`,
    `/v2/location/${LOC}/conversations/conversations`,
    `/v2/location/${LOC}/conversations/manual_actions`,
    `/v2/location/${LOC}/settings/company`,
    `/v2/location/${LOC}/custom-menu-link/abcdefabcdefabcdef12`,
    `/v2/location/${LOC}/opportunities/list`,
  ]) assert.equal(parseGhlUrl(`https://app.gohighlevel.com${path}`), null, path);
});

test("an address that isn't GHL is no one, whatever its path", () => {
  assert.equal(parseGhlUrl(`https://evil.example.com/v2/location/${LOC}/contacts/detail/${CONTACT}`), null);
  assert.equal(parseGhlUrl(`https://gohighlevel.com.evil.example/v2/location/${LOC}/contacts/detail/${CONTACT}`), null);
  assert.equal(parseGhlUrl(`http://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${CONTACT}`), null, "not https");
  assert.equal(parseGhlUrl("not a url"), null);
  assert.equal(parseGhlUrl(undefined), null);
});
