import { describe, it, expect } from 'vitest'
import { cn } from '../../../src/renderer/lib/utils'

describe('cn()', () => {
  it('should concatenate class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('should deduplicate tailwind classes via tailwind-merge', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })

  it('should handle conditional class names', () => {
    expect(cn(true && 'a', false && 'b')).toBe('a')
  })

  it('should handle empty inputs', () => {
    expect(cn()).toBe('')
  })

  it('should handle mixed conditional and regular classes', () => {
    expect(cn('base', true && 'active', false && 'disabled')).toBe('base active')
  })
})
