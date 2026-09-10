import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, faceThumbnailUrl } from '../lib/api';
import { IconCheck, IconUsers } from './Icons';
import './FacesPanel.css';

/**
 * Who is in this photo, shown inside the lightbox info panel.
 *
 * This is where naming actually belongs: the People page shows a face out of
 * context, whereas here the photo is right there, which is what makes an
 * unfamiliar face recognisable in the first place.
 */
export function FacesPanel({ assetId }: { assetId: string }) {
  const queryClient = useQueryClient();
  const [namingFaceId, setNamingFaceId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const { data: faces } = useQuery({
    queryKey: ['faces', assetId],
    queryFn: () => api.facesForAsset(assetId),
  });

  const { data: people } = useQuery({ queryKey: ['people'], queryFn: api.people });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['faces', assetId] });
    void queryClient.invalidateQueries({ queryKey: ['people'] });
  };

  const rename = useMutation({
    mutationFn: ({ personId, name }: { personId: string; name: string }) =>
      api.updatePerson(personId, { name: name || null }),
    onSuccess: () => {
      invalidate();
      setNamingFaceId(null);
      setDraftName('');
    },
  });

  /**
   * Removing a face from its group makes it a person of its own rather than
   * deleting it — it is still a real face, and discarding it would mean
   * re-detecting the whole photo to get it back.
   */
  const detach = useMutation({
    mutationFn: (faceId: string) => api.detachFace(faceId),
    onSuccess: invalidate,
  });

  if (!faces || faces.length === 0) return null;

  const nameFor = (personId: string | null) =>
    personId ? (people?.find((p) => p.id === personId)?.name ?? null) : null;

  return (
    <div className="faces-panel">
      <dt>{faces.length === 1 ? 'Person' : 'People'}</dt>
      <dd>
        <div className="faces-list">
          {faces.map((face) => {
            const name = nameFor(face.personId);
            const isNaming = namingFaceId === face.id;

            return (
              <div key={face.id} className="face-chip">
                <div className="face-chip-avatar">
                  <img src={faceThumbnailUrl(face.id)} alt="" loading="lazy" />
                </div>

                {isNaming ? (
                  <form
                    className="face-chip-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (face.personId) {
                        rename.mutate({ personId: face.personId, name: draftName.trim() });
                      }
                    }}
                  >
                    <input
                      className="input face-chip-input"
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      placeholder="Name"
                      maxLength={120}
                      autoFocus
                      onBlur={() => setNamingFaceId(null)}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary btn-icon face-chip-save"
                      // mousedown fires before the input's blur, which would
                      // otherwise close the form before the click registers.
                      onMouseDown={(event) => event.preventDefault()}
                      aria-label="Save name"
                    >
                      <IconCheck size={14} />
                    </button>
                  </form>
                ) : (
                  <div className="face-chip-body">
                    {name && face.personId ? (
                      <Link to={`/people/${face.personId}`} className="face-chip-name">
                        {name}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="face-chip-name is-unnamed"
                        onClick={() => {
                          setNamingFaceId(face.id);
                          setDraftName('');
                        }}
                      >
                        Add a name
                      </button>
                    )}

                    <button
                      type="button"
                      className="face-chip-detach"
                      onClick={() => detach.mutate(face.id)}
                      title="This is not the same person"
                    >
                      Not them
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </dd>
    </div>
  );
}

/**
 * Boxes drawn over the photo itself.
 *
 * Positions are stored normalised against the preview, so they scale with
 * whatever size the image is actually being displayed at.
 */
export function FaceOverlay({ assetId, visible }: { assetId: string; visible: boolean }) {
  const { data: faces } = useQuery({
    queryKey: ['faces', assetId],
    queryFn: () => api.facesForAsset(assetId),
    enabled: visible,
  });

  if (!visible || !faces || faces.length === 0) return null;

  return (
    <div className="face-overlay" aria-hidden="true">
      {faces.map((face) => (
        <div
          key={face.id}
          className="face-overlay-box"
          style={{
            left: `${face.x * 100}%`,
            top: `${face.y * 100}%`,
            width: `${face.width * 100}%`,
            height: `${face.height * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

export function FacesIndicator({ assetId }: { assetId: string }) {
  const { data: faces } = useQuery({
    queryKey: ['faces', assetId],
    queryFn: () => api.facesForAsset(assetId),
  });

  if (!faces || faces.length === 0) return null;
  return (
    <span className="faces-indicator" title={`${faces.length} face(s) in this photo`}>
      <IconUsers size={15} />
      {faces.length}
    </span>
  );
}
