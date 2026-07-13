import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'

export default function Discover() {
  return (
    <div className="animate-fade-up grid min-h-[60vh] place-items-center">
      <div className="mx-auto max-w-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-xl text-center shadow-card">
        <span className="mx-auto mb-md grid h-14 w-14 place-items-center rounded-2xl bg-primary-fixed/60 text-primary">
          <Icon name="forum" size={28} />
        </span>
        <h1 className="text-display-sm tracking-tight text-on-surface">Browse your meetings</h1>
        <p className="mt-2 text-body-md text-secondary">
          Find meetings, people and topics across everything the notetaker has recorded.
        </p>
        <div className="mt-lg flex flex-wrap items-center justify-center gap-2.5">
          <Link
            to="/meetings"
            className="press inline-flex items-center gap-2 rounded-lg bg-primary px-lg py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
          >
            <Icon name="forum" size={18} /> View all meetings
          </Link>
          <Link
            to="/search"
            className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-lg py-2.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
          >
            <Icon name="search" size={18} /> Search transcripts
          </Link>
        </div>
      </div>
    </div>
  )
}
