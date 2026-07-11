// dm = AWS, dm1 = Azure, dm2 = GCP
export function getCloudProvider(region) {
  if (region.startsWith('dm2')) return 'GCP'
  if (region.startsWith('dm1')) return 'Azure'
  if (region.startsWith('dm'))  return 'AWS'
  return null
}

export function getLoginUrl(region) {
  return `https://${region}.informaticacloud.com/ma/api/v2/user/login`
}

// Basic format check: must be dm, dm1, or dm2 followed by a hyphen and letters
export function isValidRegion(region) {
  return /^dm\d*-[a-z]+(\d*)?$/.test(region.trim())
}
