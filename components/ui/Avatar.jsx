// An address's identicon (see lib/client/format.js#identicon), as the
// `.avatar` circle the stylesheet sizes.
import { identicon } from '@/lib/client/format';

export default function Avatar({ addr }) {
  const style = addr ? { backgroundImage: `url("${identicon(addr)}")`, backgroundSize: 'cover' } : undefined;
  return <span className="avatar" style={style} />;
}
