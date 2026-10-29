import React from 'react'
import { cn } from '../../lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'flex h-8 w-full rounded-input border-0 border-b bg-transparent px-2 text-content',
          'placeholder:text-text-secondary/60',
          'focus:outline-none focus:border-accent focus:border-b-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'transition-colors',
          error && 'border-red-400 focus:border-red-500',
          className
        )}
        {...props}
      />
    )
  }
)

Input.displayName = 'Input'
