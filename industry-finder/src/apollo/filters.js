// Canonical filters for Apollo iteration

// Minimal US states list (expand as needed)
const US_STATES = [
  'Alabama, US','Alaska, US','Arizona, US','Arkansas, US','California, US',
  'Colorado, US','Connecticut, US','Delaware, US','Florida, US','Georgia, US',
  'Hawaii, US','Idaho, US','Illinois, US','Indiana, US','Iowa, US',
  'Kansas, US','Kentucky, US','Louisiana, US','Maine, US','Maryland, US',
  'Massachusetts, US','Michigan, US','Minnesota, US','Mississippi, US','Missouri, US',
  'Montana, US','Nebraska, US','Nevada, US','New Hampshire, US','New Jersey, US',
  'New Mexico, US','New York, US','North Carolina, US','North Dakota, US','Ohio, US',
  'Oklahoma, US','Oregon, US','Pennsylvania, US','Rhode Island, US','South Carolina, US',
  'South Dakota, US','Tennessee, US','Texas, US','Utah, US','Vermont, US',
  'Virginia, US','Washington, US','West Virginia, US','Wisconsin, US','Wyoming, US',
];

// Employee buckets (inclusive ranges), Apollo format `min,max` with empty for open end
// Examples: ",3" (<=3), "4,6" (4-6), "10001," (>=10001)
const EMPLOYEE_BUCKETS = [
  ',3', '4,6', '7,10', '11,20', '21,50', '51,100', '101,200', '201,500',
  '501,1000', '1001,2000', '2001,5000', '5001,10000', '10001,',
];

module.exports = { US_STATES, EMPLOYEE_BUCKETS };


