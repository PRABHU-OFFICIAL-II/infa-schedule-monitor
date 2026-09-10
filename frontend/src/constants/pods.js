// dm = AWS, dm1 = Azure, dm2 = GCP, dm3 = OCI, dmp = DMP/C360, dmr = Preview
export function getCloudProvider(region) {
  if (region.includes('icinq'))  return 'AWS'
  if (region.startsWith('dm3'))  return 'OCI'
  if (region.startsWith('dm2'))  return 'GCP'
  if (region.startsWith('dm1'))  return 'Azure'
  if (region.startsWith('dmp'))  return 'GCP'
  if (region.startsWith('dm'))   return 'AWS'
  return null
}

export function getLoginUrl(region) {
  return `https://${region}.informaticacloud.com/ma/api/v2/user/login`
}

export function isValidRegion(region) {
  const r = region.trim()
  return /^dm[a-z\d]*-[a-z][a-z\d]*$/.test(r) || r === 'na1.iics-icinq1'
}

export const PODS = [
  {
    group: 'US',
    pods: [
      { label: 'IICS AWS US',   region: 'dm-us'   },
      { label: 'IICS Azure US', region: 'dm1-us'  },
      { label: 'IICS GCP US',   region: 'dm2-us'  },
      { label: 'IICS C360 US',  region: 'dmp-us'  },
      { label: 'IICS OCI US',   region: 'dm3-us'  },
    ],
  },
  {
    group: 'EMEA',
    pods: [
      { label: 'IICS AWS EMEA',   region: 'dm-em'    },
      { label: 'IICS Azure EMEA', region: 'dm1-em'   },
      { label: 'IICS GCP EMEA',   region: 'dm2-em'   },
      { label: 'IICS Azure EMCE', region: 'dm1-emce' },
      { label: 'IICS Azure EMSE', region: 'dm1-emse' },
      { label: 'IICS AWS UK',     region: 'dm-uk'    },
    ],
  },
  {
    group: 'APAC',
    pods: [
      { label: 'IICS AWS APJ',    region: 'dm-ap'    },
      { label: 'IICS Azure NTT',  region: 'dm1-ap'   },
      { label: 'IICS Azure APSE', region: 'dm1-apse' },
      { label: 'IICS Azure APAU', region: 'dm1-apau' },
      { label: 'IICS AWS APNE',   region: 'dm-apne'  },
    ],
  },
  {
    group: 'Canada',
    pods: [
      { label: 'IICS AWS Canada',   region: 'dm-na'  },
      { label: 'IICS Azure Canada', region: 'dm1-ca' },
    ],
  },
  {
    group: 'Middle East',
    pods: [
      { label: 'IICS GCP Saudi', region: 'dm2-me' },
    ],
  },
  {
    group: 'Staging / Preview',
    pods: [
      { label: 'IICS AWS Preview',      region: 'dmr-us'        },
      { label: 'IICS EMEA Preview',     region: 'dmr-em'        },
      { label: 'IICS AWS Staging',      region: 'dm-staging'    },
      { label: 'IICS Azure AZ Staging', region: 'dm1-azstaging' },
      { label: 'IICS GCP Staging',      region: 'dm2-staging'   },
      { label: 'IICS OCI Staging',      region: 'dm3-staging'   },
    ],
  },
  {
    group: 'Special',
    pods: [
      { label: 'IICS Azure USE2',  region: 'dm1-use'         },
      { label: 'IICS AWS ICINQ1',  region: 'na1.iics-icinq1' },
    ],
  },
]
