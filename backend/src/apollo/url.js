// Apollo Companies URL generator
// Builds URLs like:
// https://app.apollo.io/#/companies?qOrganizationKeywordTags[]=painting%20services&includedOrganizationKeywordFields[]=tags&includedOrganizationKeywordFields[]=name&organizationIndustryTagIds[]=5567cd4773696439dd350000&page=1&sortAscending=false&sortByField=organization_estimated_number_employees&organizationNumEmployeesRanges[]=%2C3&organizationLocations[]=California%2C%20US

function encodeParam(value) {
  return encodeURIComponent(String(value || ''));
}

function buildCompaniesUrl({
  keywords = [],
  industryTagIds = [],
  page = 1,
  sortAscending = false,
  sortByField = 'organization_estimated_number_employees',
  employeeRanges = [], // array of strings like ",3" or "4,6" or "10001,"
  locations = [], // strings like "California, US"
} = {}) {
  const base = 'https://app.apollo.io/#/companies';
  const parts = [];

  // Keywords as qOrganizationKeywordTags[]
  for (const kw of keywords) {
    const v = String(kw || '').trim();
    if (!v) continue;
    parts.push(`qOrganizationKeywordTags[]=${encodeParam(v)}`);
  }
  // Always include these fields for keyword matching
  parts.push(`includedOrganizationKeywordFields[]=${encodeParam('tags')}`);
  parts.push(`includedOrganizationKeywordFields[]=${encodeParam('name')}`);

  // Optional industry tag filters
  for (const id of industryTagIds) {
    const v = String(id || '').trim();
    if (!v) continue;
    parts.push(`organizationIndustryTagIds[]=${encodeParam(v)}`);
  }

  // Sorting
  parts.push(`page=${encodeParam(Math.max(1, Number(page) || 1))}`);
  parts.push(`sortAscending=${encodeParam(Boolean(sortAscending))}`);
  if (sortByField) parts.push(`sortByField=${encodeParam(sortByField)}`);

  // Employee ranges
  for (const rng of employeeRanges) {
    const v = String(rng || '').trim();
    if (!v) continue;
    parts.push(`organizationNumEmployeesRanges[]=${encodeParam(v)}`);
  }

  // Locations
  for (const loc of locations) {
    const v = String(loc || '').trim();
    if (!v) continue;
    parts.push(`organizationLocations[]=${encodeParam(v)}`);
  }

  const query = parts.join('&');
  return `${base}?${query}`;
}

module.exports = { buildCompaniesUrl };


