import { onSettled } from 'solid-js'
import { useNavigate } from '@solidjs/router'

/**
 * Unknown URLs bounce to the reader root, as the old SPA did. In practice
 * middleware already redirected before rendering; this catches a client-side
 * navigation to a path the route list does not know.
 */
export const NotFoundPage = () => {
  const navigate = useNavigate()
  onSettled(() => {
    void navigate('/', { replace: true })
  })
  return null
}

export default NotFoundPage
