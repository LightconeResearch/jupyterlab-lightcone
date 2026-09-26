import { JlThemeProvider } from '@jupyter/chat';
import type { IThemeManager } from '@jupyterlab/apputils';
import type { TranslationBundle } from '@jupyterlab/translation';
import { Button, ListItemText, Menu, MenuItem } from '@mui/material';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import CheckIcon from '@mui/icons-material/Check';
import React, { useEffect, useId, useState } from 'react';
import type { IProjectAgents } from '../api';

interface IAgentPickerProps {
  options: IProjectAgents['personas'];
  selected: string;
  placeholder: string;
  disabled: boolean;
  themes: IThemeManager;
  trans: TranslationBundle;
  onSelect: (id: string) => void;
}

const SELECTOR = 'jp-jai-personaControls';
const MENU = 'jp-jai-controlMenu';

/** Use Jupyter AI's MUI primitives and styles without its chat-bound toolbar state. */
export function AgentPicker(props: IAgentPickerProps): React.ReactElement {
  const { options, selected, placeholder, disabled, themes, trans, onSelect } =
    props;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const id = useId();
  const active = options.find(option => option.id === selected);
  useEffect(() => {
    if (disabled) setAnchor(null);
  }, [disabled]);
  return (
    <JlThemeProvider themeManager={themes}>
      <div className="jp-jupyterlab-lightcone-Home-agentPicker jp-ThemedContainer">
        <Button
          id={id}
          type="button"
          className={`${SELECTOR} ${SELECTOR}-persona-btn`}
          size="small"
          variant="text"
          disableRipple
          disabled={disabled}
          startIcon={<AgentAvatar url={active?.avatar_url} />}
          endIcon={<ArrowDropDownIcon className={`${SELECTOR}-arrow`} />}
          title={trans.__('Choose an agent')}
          aria-label={trans.__('Agent: %1', active?.name ?? placeholder)}
          aria-haspopup="menu"
          aria-expanded={!!anchor}
          aria-controls={anchor ? `${id}-menu` : undefined}
          onClick={event => setAnchor(event.currentTarget)}
        >
          <span className={`${SELECTOR}-persona`}>
            {active?.name ?? placeholder}
          </span>
        </Button>
        <Menu
          anchorEl={anchor}
          open={!!anchor}
          onClose={() => setAnchor(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{
            paper: { className: `${MENU}-paper` },
            list: { id: `${id}-menu`, 'aria-labelledby': id }
          }}
        >
          {options.map(option => (
            <MenuItem
              key={option.id}
              selected={option.id === selected}
              onClick={() => {
                onSelect(option.id);
                setAnchor(null);
              }}
            >
              <AgentAvatar url={option.avatar_url} />
              <ListItemText
                primary={option.name}
                classes={{ primary: `${MENU}-name` }}
              />
              {option.id === selected ? (
                <CheckIcon className={`${MENU}-check`} fontSize="small" />
              ) : null}
            </MenuItem>
          ))}
        </Menu>
      </div>
    </JlThemeProvider>
  );
}

/** Match the chat picker's avatar and its empty-image alignment. */
function AgentAvatar({ url }: { url?: string | null }): React.ReactElement {
  return url ? (
    <img className={`${SELECTOR}-avatar`} src={url} alt="" />
  ) : (
    <span className={`${SELECTOR}-avatar-spacer`} />
  );
}
